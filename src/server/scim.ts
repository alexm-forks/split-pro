import { type PrismaClient, type User } from '@prisma/client';
import { z } from 'zod';

import { DEFAULT_CURRENCY } from '~/lib/currency';

/**
 * Alex hack: a minimal SCIM 2.0 server for provisioning users from Pocket ID (its SCIM client
 * lists /Users and /Groups, then POSTs, PUTs or DELETEs, matching records only by externalId).
 *
 * Nothing new is stored: a provisioned user is linked through the same Account row NextAuth
 * writes on a first OIDC login (provider = the OIDC provider id, providerAccountId = Pocket ID's
 * user id, which is also its OIDC `sub`), so their first Pocket ID sign-in lands on this user.
 * Removals and deactivations are deliberately ignored: Pocket ID only creates and updates people.
 */

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

const MAX_PAGE_SIZE = 1000;

export class ScimError extends Error {
  readonly status: number;
  readonly scimType?: string;

  constructor(status: number, message: string, scimType?: string) {
    super(message);
    this.status = status;
    this.scimType = scimType;
  }
}

export const scimErrorBody = (status: number, detail: string, scimType?: string) => ({
  schemas: [SCIM_ERROR_SCHEMA],
  status: String(status),
  detail,
  ...(scimType ? { scimType } : {}),
});

const scimUserInput = z.object({
  externalId: z.string().trim().min(1),
  userName: z.string().optional(),
  displayName: z.string().optional(),
  name: z
    .object({
      formatted: z.string().optional(),
      givenName: z.string().optional(),
      familyName: z.string().optional(),
    })
    .optional(),
  emails: z.array(z.object({ value: z.string(), primary: z.boolean().optional() })).optional(),
});

interface ProvisionedUser {
  externalId: string;
  name: string | null;
  email: string | null;
}

/** The fields Split Pro keeps from a SCIM user resource. */
export const parseScimUser = (body: unknown): ProvisionedUser => {
  const result = scimUserInput.safeParse(body);
  if (!result.success) {
    throw new ScimError(400, `Invalid user: ${result.error.issues[0]?.message}`, 'invalidValue');
  }
  const { externalId, userName, displayName, name, emails } = result.data;
  const rawEmail = (emails?.find((e) => e.primary) ?? emails?.[0])?.value.trim().toLowerCase();
  const email = rawEmail && z.string().email().safeParse(rawEmail).success ? rawEmail : null;
  const fullName = [name?.givenName, name?.familyName].filter(Boolean).join(' ');
  const displayed = [displayName, name?.formatted, fullName, userName]
    .map((value) => value?.trim())
    .find(Boolean);
  return { externalId, name: displayed ?? email, email };
};

export const toScimUser = (user: Pick<User, 'id' | 'name' | 'email'>, externalId: string) => ({
  schemas: [SCIM_USER_SCHEMA],
  id: String(user.id),
  externalId,
  userName: user.email ?? String(user.id),
  displayName: user.name ?? undefined,
  emails: user.email ? [{ value: user.email, primary: true }] : [],
  active: true,
  meta: { resourceType: 'User' },
});

export const listResponse = <T>(resources: T[], totalResults: number, startIndex: number) => ({
  schemas: [SCIM_LIST_SCHEMA],
  totalResults,
  startIndex,
  itemsPerPage: resources.length,
  Resources: resources,
});

/** SCIM pagination: startIndex is 1-based; count is capped (Pocket ID asks for 1000). */
export const pageParams = (startIndex?: string, count?: string) => {
  const start = Math.max(1, Number.parseInt(startIndex ?? '1', 10) || 1);
  const size = Math.min(
    MAX_PAGE_SIZE,
    Math.max(0, Number.parseInt(count ?? String(MAX_PAGE_SIZE), 10) || 0),
  );
  return { start, size };
};

const provisionedWhere = (provider: string) => ({
  deletedAt: null,
  accounts: { some: { provider } },
});

/** Users linked to the OIDC provider, i.e. everyone Pocket ID knows about. */
export const listUsers = async (
  db: PrismaClient,
  provider: string,
  startIndex?: string,
  count?: string,
) => {
  const { start, size } = pageParams(startIndex, count);
  const where = provisionedWhere(provider);
  const [users, total] = await Promise.all([
    db.user.findMany({
      where,
      orderBy: { id: 'asc' },
      skip: start - 1,
      take: size,
      include: { accounts: { where: { provider }, select: { providerAccountId: true } } },
    }),
    db.user.count({ where }),
  ]);
  return listResponse(
    users.map((user) => toScimUser(user, user.accounts[0]?.providerAccountId ?? '')),
    total,
    start,
  );
};

const findProvisioned = async (db: PrismaClient, provider: string, id: string) => {
  if (!/^\d+$/.test(id)) {
    return null;
  }
  return db.user.findFirst({
    where: { id: Number(id), ...provisionedWhere(provider) },
    include: { accounts: { where: { provider }, select: { providerAccountId: true } } },
  });
};

export const getUser = async (db: PrismaClient, provider: string, id: string) => {
  const user = await findProvisioned(db, provider, id);
  if (!user) {
    throw new ScimError(404, `User ${id} not found`);
  }
  return toScimUser(user, user.accounts[0]?.providerAccountId ?? '');
};

/**
 * Create, or link: an existing link for the externalId wins, then a user with the same email
 * (e.g. someone added to an expense by email before they had a login), then a new user.
 */
export const createUser = async (db: PrismaClient, provider: string, body: unknown) => {
  const input = parseScimUser(body);
  return db.$transaction(async (tx) => {
    const linked = await tx.account.findUnique({
      where: {
        provider_providerAccountId: { provider, providerAccountId: input.externalId },
      },
      include: { user: true },
    });
    if (linked) {
      if (linked.user.deletedAt) {
        throw new ScimError(409, 'That Pocket ID user belongs to a deleted account', 'uniqueness');
      }
      return toScimUser(linked.user, input.externalId);
    }

    const existing = input.email
      ? await tx.user.findFirst({
          where: { email: { equals: input.email, mode: 'insensitive' }, deletedAt: null },
          include: { accounts: { where: { provider }, select: { providerAccountId: true } } },
        })
      : null;
    if (existing && 0 < existing.accounts.length) {
      // Linking a second Pocket ID identity would let both log in as this user.
      throw new ScimError(
        409,
        `${input.email} is already linked to another Pocket ID user`,
        'uniqueness',
      );
    }

    // A linked user takes Pocket ID's name straight away, as every later sync (PUT) sets it anyway.
    const user = existing
      ? await tx.user.update({
          where: { id: existing.id },
          data: { name: input.name ?? existing.name },
        })
      : await tx.user.create({
          data: { name: input.name, email: input.email, currency: DEFAULT_CURRENCY },
        });
    await tx.account.create({
      data: { userId: user.id, type: 'oidc', provider, providerAccountId: input.externalId },
    });
    return toScimUser(user, input.externalId);
  });
};

/** Update the name and email; `active` is ignored (removals and deactivations aren't synced). */
export const replaceUser = async (
  db: PrismaClient,
  provider: string,
  id: string,
  body: unknown,
) => {
  const input = parseScimUser(body);
  const user = await findProvisioned(db, provider, id);
  if (!user) {
    throw new ScimError(404, `User ${id} not found`);
  }
  const externalId = user.accounts[0]?.providerAccountId ?? input.externalId;

  let { email } = user;
  if (input.email && input.email !== user.email?.toLowerCase()) {
    const clash = await db.user.findFirst({
      where: { email: { equals: input.email, mode: 'insensitive' }, id: { not: user.id } },
      select: { id: true },
    });
    if (clash) {
      console.warn(`SCIM: not changing user ${user.id}'s email to ${input.email}: already in use`);
    } else {
      ({ email } = input);
    }
  }

  const updated = await db.user.update({
    where: { id: user.id },
    data: { name: input.name ?? user.name, email },
  });
  return toScimUser(updated, externalId);
};

/** Groups aren't stored: echo them back so Pocket ID's sync succeeds. */
export const echoGroup = (body: unknown, id?: string) => {
  const group = z
    .object({ externalId: z.string().optional(), displayName: z.string().optional() })
    .passthrough()
    .safeParse(body);
  if (!group.success) {
    throw new ScimError(400, 'Invalid group', 'invalidValue');
  }
  return {
    ...group.data,
    schemas: [SCIM_GROUP_SCHEMA],
    id: id ?? group.data.externalId ?? crypto.randomUUID(),
  };
};
