import { createHash, timingSafeEqual } from 'node:crypto';

import { type Session } from 'next-auth';
import { type IncomingHttpHeaders } from 'node:http';

import { type PrismaClient, type User } from '@prisma/client';

/**
 * API-key authentication helpers for the public REST API (`/api/v1`).
 *
 * Alex hack: instead of upstream's stored, per-user keys (which need an `ApiKey` table), keys
 * come from the `API_KEYS` env var as comma-separated `email:secret` pairs. Nothing is
 * stored in the database; rotate or revoke a key by changing the env var and restarting.
 */

export interface ConfiguredApiKey {
  email: string;
  key: string;
}

/** Parse `API_KEYS` (`email:secret,email2:secret2`). Entries without both parts are ignored. */
export const parseConfiguredApiKeys = (value: string | undefined): ConfiguredApiKey[] =>
  (value ?? '')
    .split(',')
    .map((entry) => {
      const separator = entry.indexOf(':');
      if (-1 === separator) {
        return { email: '', key: '' };
      }
      return {
        email: entry.slice(0, separator).trim().toLowerCase(),
        key: entry.slice(separator + 1).trim(),
      };
    })
    .filter(({ email, key }) => '' !== email && '' !== key);

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time comparison (hashing first so differing lengths don't leak). */
const keysMatch = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

/**
 * Extract a bearer token from request headers. Accepts `Authorization: Bearer
 * <key>` (preferred) or the `X-API-Key: <key>` header. Returns null when absent.
 */
export function parseApiKeyFromHeaders(headers: IncomingHttpHeaders): string | null {
  const authorization = headers.authorization;
  if (authorization) {
    const [scheme, token] = authorization.split(' ');
    if ('bearer' === scheme?.toLowerCase() && token) {
      return token.trim();
    }
  }

  const apiKeyHeader = headers['x-api-key'];
  if ('string' === typeof apiKeyHeader && apiKeyHeader.trim()) {
    return apiKeyHeader.trim();
  }

  return null;
}

/**
 * Look up the user a plaintext API key belongs to, by matching it against the configured
 * keys and then finding that email's user. Returns null when the key or user is unknown.
 */
export async function resolveApiKeyUser(
  db: PrismaClient,
  rawKey: string | null,
  configuredKeys: ConfiguredApiKey[],
): Promise<{ user: User; expiresAt: Date | null } | null> {
  if (!rawKey) {
    return null;
  }

  // Compare against every entry so timing doesn't reveal which one matched.
  const match = configuredKeys.reduce<ConfiguredApiKey | undefined>(
    (found, entry) => (keysMatch(rawKey, entry.key) ? entry : found),
    undefined,
  );
  if (!match) {
    return null;
  }

  const user = await db.user.findFirst({
    where: { email: { equals: match.email, mode: 'insensitive' } },
  });

  return user ? { user, expiresAt: null } : null;
}

/**
 * Build a next-auth session user from a database user, matching the shape the
 * cookie `session` callback produces in `~/server/auth`, so procedures behave
 * identically whether authenticated by cookie or API key.
 */
export function toSessionUser(user: User): Session['user'] {
  return {
    id: user.id,
    name: user.name ?? '',
    email: user.email ?? '',
    image: user.image ?? '',
    currency: user.currency,
    defaultCurrency: user.defaultCurrency,
    obapiProviderId: user.obapiProviderId ?? undefined,
    bankingId: user.bankingId ?? undefined,
    preferredLanguage: user.preferredLanguage,
    hiddenFriendIds: user.hiddenFriendIds,
  };
}
