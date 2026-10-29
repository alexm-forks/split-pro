import { type PrismaClient, type User } from '@prisma/client';

import {
  parseApiKeyFromHeaders,
  parseConfiguredApiKeys,
  resolveApiKeyUser,
} from '~/server/api/apiKey';

const user = { id: 7, email: 'alex@example.com' } as User;

const mockDb = (found: User | null) => {
  const findFirst = jest.fn().mockResolvedValue(found);
  return { db: { user: { findFirst } } as unknown as PrismaClient, findFirst };
};

describe('parseConfiguredApiKeys', () => {
  it('should parse email:secret pairs, lowercasing emails', () => {
    expect(parseConfiguredApiKeys(' Alex@Example.com:abc:def , b@example.com:xyz')).toEqual([
      { email: 'alex@example.com', key: 'abc:def' },
      { email: 'b@example.com', key: 'xyz' },
    ]);
  });

  it('should ignore empty and incomplete entries', () => {
    expect(parseConfiguredApiKeys(undefined)).toEqual([]);
    expect(parseConfiguredApiKeys('')).toEqual([]);
    expect(parseConfiguredApiKeys('nokey,:secret,a@example.com:,,')).toEqual([]);
  });
});

describe('parseApiKeyFromHeaders', () => {
  it('should read a bearer token or X-API-Key header', () => {
    expect(parseApiKeyFromHeaders({ authorization: 'Bearer abc' })).toBe('abc');
    expect(parseApiKeyFromHeaders({ 'x-api-key': ' abc ' })).toBe('abc');
    expect(parseApiKeyFromHeaders({ authorization: 'Basic abc' })).toBeNull();
    expect(parseApiKeyFromHeaders({})).toBeNull();
  });
});

describe('resolveApiKeyUser', () => {
  const keys = parseConfiguredApiKeys('alex@example.com:right-secret');

  it('should resolve a matching key to its user, without expiry', async () => {
    const { db, findFirst } = mockDb(user);
    await expect(resolveApiKeyUser(db, 'right-secret', keys)).resolves.toEqual({
      user,
      expiresAt: null,
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { email: { equals: 'alex@example.com', mode: 'insensitive' } },
    });
  });

  it('should reject wrong, missing or unconfigured keys without a lookup', async () => {
    const { db, findFirst } = mockDb(user);
    await expect(resolveApiKeyUser(db, 'wrong-secret', keys)).resolves.toBeNull();
    await expect(resolveApiKeyUser(db, null, keys)).resolves.toBeNull();
    await expect(resolveApiKeyUser(db, 'right-secret', [])).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('should reject a key whose email has no user', async () => {
    const { db } = mockDb(null);
    await expect(resolveApiKeyUser(db, 'right-secret', keys)).resolves.toBeNull();
  });
});
