import { type CreateNextContextOptions } from '@trpc/server/adapters/next';
import { type Session } from 'next-auth';

import { env } from '~/env';
import { db } from '~/server/db';

import {
  parseApiKeyFromHeaders,
  parseConfiguredApiKeys,
  resolveApiKeyUser,
  toSessionUser,
} from './apiKey';

/** Fallback for the synthetic session expiry when the key never expires. */
const NON_EXPIRING_SESSION_MS = 100 * 365 * 24 * 60 * 60 * 1000; // 100 years

/**
 * Public REST API context (`/api/v1`). Authenticates via API key instead of the
 * cookie session used by the app's `/api/trpc` handler, but returns the same
 * context shape (`{ session, db }`) so procedures are shared between them.
 *
 * Keys come from the `API_KEYS` env var (see `./apiKey`) and never expire, so
 * `session.expires` is a synthetic far-future date.
 */
export const createApiContext = async (opts: CreateNextContextOptions) => {
  const rawKey = parseApiKeyFromHeaders(opts.req.headers);
  const resolved = await resolveApiKeyUser(db, rawKey, parseConfiguredApiKeys(env.API_KEYS));

  const session: Session | null = resolved
    ? {
        user: toSessionUser(resolved.user),
        expires: (
          resolved.expiresAt ?? new Date(Date.now() + NON_EXPIRING_SESSION_MS)
        ).toISOString(),
      }
    : null;

  return { session, db };
};
