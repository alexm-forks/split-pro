import { PrismaAdapter } from '@next-auth/prisma-adapter';

import { createUser, getUser, listUsers, replaceUser } from '~/server/scim';

import { db } from './database';
import { testUser } from './factories';

const PROVIDER = 'pocketid';

// What Pocket ID sends for a user (externalId is its user id, which is also its OIDC sub).
const pocketIdUser = (externalId: string, email: string, displayName = 'Sam Smith') => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
  externalId,
  userName: email.split('@')[0],
  name: { givenName: 'Sam', familyName: 'Smith' },
  displayName,
  active: true,
  emails: [{ value: email, primary: true }],
});

describe('SCIM provisioning', () => {
  it('creates a user linked to the Pocket ID login', async () => {
    const created = await createUser(db, PROVIDER, pocketIdUser('pid-1', 'Sam@Example.test'));
    expect(created).toMatchObject({
      externalId: 'pid-1',
      userName: 'sam@example.test',
      displayName: 'Sam Smith',
    });

    const user = await db.user.findUniqueOrThrow({
      where: { id: Number(created.id) },
      include: { accounts: true },
    });
    expect(user).toMatchObject({
      email: 'sam@example.test',
      name: 'Sam Smith',
      currency: 'GBP',
      deletedAt: null,
    });
    expect(user.accounts).toEqual([
      expect.objectContaining({ provider: PROVIDER, type: 'oidc', providerAccountId: 'pid-1' }),
    ]);

    // NextAuth's OIDC sign-in looks the account up by (provider, sub): it lands on this user.
    const adapter = PrismaAdapter(db);
    const signedIn = await adapter.getUserByAccount!({
      provider: PROVIDER,
      providerAccountId: 'pid-1',
    });
    expect(signedIn?.id).toBe(user.id);
  });

  it('links someone already added by email instead of duplicating them', async () => {
    const placeholder = await testUser('sam');
    await db.user.update({ where: { id: placeholder.id }, data: { email: 'sam@example.test' } });

    const created = await createUser(db, PROVIDER, pocketIdUser('pid-1', 'SAM@example.test'));
    expect(created.id).toBe(String(placeholder.id));
    expect(created.displayName).toBe('Sam Smith');
    expect(await db.user.count()).toBe(1);
    expect(
      await db.account.count({ where: { userId: placeholder.id, providerAccountId: 'pid-1' } }),
    ).toBe(1);
  });

  it('links a user who already signed in with Pocket ID (same sub) without a second account', async () => {
    const existing = await testUser('Sam');
    await db.account.create({
      data: { userId: existing.id, type: 'oauth', provider: PROVIDER, providerAccountId: 'pid-1' },
    });
    const created = await createUser(db, PROVIDER, pocketIdUser('pid-1', 'other@example.test'));
    expect(created.id).toBe(String(existing.id));
    expect(await db.account.count()).toBe(1);
  });

  it('is idempotent for the same externalId', async () => {
    const first = await createUser(db, PROVIDER, pocketIdUser('pid-1', 'sam@example.test'));
    const second = await createUser(db, PROVIDER, pocketIdUser('pid-1', 'sam@example.test'));
    expect(second.id).toBe(first.id);
    expect(await db.user.count()).toBe(1);
    expect(await db.account.count()).toBe(1);
  });

  it('refuses to attach a second Pocket ID identity to the same email', async () => {
    await createUser(db, PROVIDER, pocketIdUser('pid-1', 'sam@example.test'));
    await expect(
      createUser(db, PROVIDER, pocketIdUser('pid-2', 'sam@example.test')),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it('creates users without an email', async () => {
    const { emails: _emails, ...noEmail } = pocketIdUser('pid-3', 'x@example.test', 'Kim');
    const created = await createUser(db, PROVIDER, noEmail);
    expect(created).toMatchObject({ displayName: 'Kim', emails: [] });
  });

  it('lists only Pocket ID-linked users, with what Pocket ID matches on', async () => {
    await testUser('Not provisioned');
    const sam = await createUser(db, PROVIDER, pocketIdUser('pid-1', 'sam@example.test'));
    const jo = await createUser(db, PROVIDER, pocketIdUser('pid-2', 'jo@example.test', 'Jo'));
    const other = await testUser('Other provider');
    await db.account.create({
      data: { userId: other.id, type: 'oauth', provider: 'google', providerAccountId: 'g' },
    });

    const page = await listUsers(db, PROVIDER, '1', '1000');
    expect(page).toMatchObject({ totalResults: 2, startIndex: 1, itemsPerPage: 2 });
    expect(page.Resources.map((r) => [r.id, r.externalId])).toEqual([
      [sam.id, 'pid-1'],
      [jo.id, 'pid-2'],
    ]);
    const second = await listUsers(db, PROVIDER, '2', '1');
    expect(second).toMatchObject({ totalResults: 2, startIndex: 2, itemsPerPage: 1 });
    expect(second.Resources[0]?.externalId).toBe('pid-2');
  });

  it('updates name and email, ignores active, and keeps an email that clashes', async () => {
    const sam = await createUser(db, PROVIDER, pocketIdUser('pid-1', 'sam@example.test'));
    const taken = await testUser('Taken');
    await db.user.update({ where: { id: taken.id }, data: { email: 'taken@example.test' } });

    const renamed = await replaceUser(db, PROVIDER, sam.id, {
      ...pocketIdUser('pid-1', 'samuel@example.test', 'Samuel'),
      active: false,
    });
    expect(renamed).toMatchObject({
      displayName: 'Samuel',
      userName: 'samuel@example.test',
      active: true,
    });

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const clash = await replaceUser(
      db,
      PROVIDER,
      sam.id,
      pocketIdUser('pid-1', 'taken@example.test', 'Samuel'),
    );
    expect(clash.userName).toBe('samuel@example.test');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    const user = await db.user.findUniqueOrThrow({ where: { id: Number(sam.id) } });
    expect(user).toMatchObject({ name: 'Samuel', email: 'samuel@example.test', deletedAt: null });
  });

  it('only exposes provisioned, non-deleted users by id', async () => {
    const plain = await testUser('Plain');
    await expect(getUser(db, PROVIDER, String(plain.id))).rejects.toMatchObject({ status: 404 });
    await expect(
      replaceUser(db, PROVIDER, String(plain.id), pocketIdUser('pid-9', 'p@example.test')),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(getUser(db, PROVIDER, 'abc')).rejects.toMatchObject({ status: 404 });

    const sam = await createUser(db, PROVIDER, pocketIdUser('pid-1', 'sam@example.test'));
    await db.user.update({ where: { id: Number(sam.id) }, data: { deletedAt: new Date() } });
    await expect(getUser(db, PROVIDER, sam.id)).rejects.toMatchObject({ status: 404 });
    expect((await listUsers(db, PROVIDER)).totalResults).toBe(0);
  });
});
