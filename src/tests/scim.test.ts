import { Readable } from 'node:stream';

import type { NextApiRequest, NextApiResponse } from 'next';

import { env } from '~/env';
import handler from '~/pages/api/scim/v2/[...path]';
import { pageParams, parseScimUser, toScimUser } from '~/server/scim';

jest.mock('~/server/db', () => ({ db: {} }));

const TOKEN = 'scim-test-token';

const request = (
  method: string,
  path: string[],
  {
    body,
    token = TOKEN,
    query = {},
  }: { body?: string; token?: string | null; query?: object } = {},
) =>
  Object.assign(Readable.from(undefined === body ? [] : [Buffer.from(body)]), {
    method,
    headers: {
      'content-type': 'application/scim+json',
      ...(null === token ? {} : { authorization: `Bearer ${token}` }),
    },
    query: { ...query, path },
  }) as unknown as NextApiRequest;

interface Recorded {
  statusCode: number;
  headers: Record<string, string>;
  body?: unknown;
}

const response = () => {
  const recorded: Recorded = { statusCode: 0, headers: {} };
  const res = {
    status: (code: number) => {
      recorded.statusCode = code;
      return res;
    },
    setHeader: (name: string, value: string) => {
      recorded.headers[name] = value;
      return res;
    },
    send: (body: string) => {
      recorded.body = JSON.parse(body) as unknown;
      return res;
    },
    end: () => res,
  };
  return { res: res as unknown as NextApiResponse, recorded };
};

const call = async (req: NextApiRequest) => {
  const { res, recorded } = response();
  await handler(req, res);
  return recorded;
};

describe('SCIM endpoint', () => {
  const original = env.SCIM_TOKEN;
  beforeEach(() => jest.replaceProperty(env, 'SCIM_TOKEN', TOKEN));
  afterAll(() => jest.replaceProperty(env, 'SCIM_TOKEN', original));

  describe('auth', () => {
    it('is off without SCIM_TOKEN', async () => {
      jest.replaceProperty(env, 'SCIM_TOKEN', undefined);
      expect((await call(request('GET', ['Users']))).statusCode).toBe(404);
    });

    it.each([null, 'wrong-token', ''])('rejects token %p', async (token) => {
      const res = await call(request('GET', ['Groups'], { token }));
      expect(res.statusCode).toBe(401);
      expect(res.headers['WWW-Authenticate']).toBe('Bearer');
      expect(res.body).toMatchObject({ status: '401' });
    });
  });

  describe('groups (accepted, not stored)', () => {
    it('lists none', async () => {
      const res = await call(
        request('GET', ['Groups'], { query: { startIndex: '1', count: '1000' } }),
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('application/scim+json');
      expect(res.body).toMatchObject({
        totalResults: 0,
        itemsPerPage: 0,
        startIndex: 1,
        Resources: [],
      });
    });

    it('echoes a created group, reading an application/scim+json body', async () => {
      const body = JSON.stringify({
        externalId: 'g-1',
        displayName: 'Family',
        members: [{ value: '3' }],
      });
      const res = await call(request('POST', ['Groups'], { body }));
      expect(res.statusCode).toBe(201);
      expect(res.body).toMatchObject({ id: 'g-1', externalId: 'g-1', displayName: 'Family' });
    });

    it('echoes updates and accepts deletes', async () => {
      const body = JSON.stringify({ externalId: 'g-1', displayName: 'Family' });
      expect((await call(request('PUT', ['Groups', 'g-1'], { body }))).body).toMatchObject({
        id: 'g-1',
      });
      expect((await call(request('DELETE', ['Groups', 'g-1']))).statusCode).toBe(204);
    });
  });

  describe('users', () => {
    it('ignores deletes', async () => {
      expect((await call(request('DELETE', ['Users', '5']))).statusCode).toBe(204);
    });

    it('rejects PATCH and unknown paths', async () => {
      const patch = await call(request('PATCH', ['Users', '5'], { body: '{}' }));
      expect(patch.statusCode).toBe(405);
      expect(patch.headers.Allow).toBe('GET, PUT, DELETE');
      expect((await call(request('GET', ['Schemas']))).statusCode).toBe(404);
    });

    it('rejects malformed JSON and invalid users without touching the database', async () => {
      const bad = await call(request('POST', ['Users'], { body: '{nope' }));
      expect(bad.statusCode).toBe(400);
      expect(bad.body).toMatchObject({ scimType: 'invalidSyntax' });
      const noId = await call(
        request('POST', ['Users'], { body: JSON.stringify({ userName: 'x' }) }),
      );
      expect(noId.statusCode).toBe(400);
      expect(noId.body).toMatchObject({ scimType: 'invalidValue' });
    });
  });
});

describe('parseScimUser', () => {
  it('reads what Pocket ID sends', () => {
    expect(
      parseScimUser({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        externalId: 'u-1',
        userName: 'sam',
        name: { givenName: 'Sam', familyName: 'Smith' },
        displayName: 'Sam S',
        active: true,
        emails: [{ value: ' Sam@Example.com ', primary: true }],
      }),
    ).toEqual({ externalId: 'u-1', name: 'Sam S', email: 'sam@example.com' });
  });

  it('falls back from display name to full name to username, and drops bad emails', () => {
    expect(parseScimUser({ externalId: 'u', name: { givenName: 'Jo' } })).toMatchObject({
      name: 'Jo',
    });
    expect(
      parseScimUser({ externalId: 'u', userName: 'kim', emails: [{ value: 'nope' }] }),
    ).toEqual({
      externalId: 'u',
      name: 'kim',
      email: null,
    });
  });
});

describe('toScimUser and pageParams', () => {
  it('maps a user, using the email as userName', () => {
    expect(toScimUser({ id: 7, name: 'Sam', email: 'sam@example.com' }, 'u-1')).toMatchObject({
      id: '7',
      externalId: 'u-1',
      userName: 'sam@example.com',
      displayName: 'Sam',
      emails: [{ value: 'sam@example.com', primary: true }],
      active: true,
    });
  });

  it('pages from 1 and caps the count', () => {
    expect(pageParams()).toEqual({ start: 1, size: 1000 });
    expect(pageParams('0', '5000')).toEqual({ start: 1, size: 1000 });
    expect(pageParams('3', 'x')).toEqual({ start: 3, size: 0 });
  });
});
