import type { NextApiRequest, NextApiResponse } from 'next';

import { env } from '~/env';
import { keysMatch } from '~/server/api/apiKey';
import { db } from '~/server/db';
import { oidcProviderId } from '~/server/oidcProvider';
import {
  ScimError,
  createUser,
  echoGroup,
  getUser,
  listResponse,
  listUsers,
  pageParams,
  replaceUser,
  scimErrorBody,
} from '~/server/scim';

// SCIM clients send application/scim+json, which Next's body parser leaves unparsed.
export const config = { api: { bodyParser: false } };

const MAX_BODY_BYTES = 1024 * 1024;

const readJson = async (req: NextApiRequest): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (MAX_BODY_BYTES < size) {
      throw new ScimError(413, 'Request body too large');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
  } catch {
    throw new ScimError(400, 'Request body is not valid JSON', 'invalidSyntax');
  }
};

const send = (res: NextApiResponse, status: number, body?: unknown) => {
  if (undefined === body) {
    return res.status(status).end();
  }
  res.setHeader('Content-Type', 'application/scim+json');
  return res.status(status).send(JSON.stringify(body));
};

const notAllowed = (res: NextApiResponse, allow: string) => {
  res.setHeader('Allow', allow);
  return send(res, 405, scimErrorBody(405, 'Method not allowed'));
};

const query = (req: NextApiRequest, key: string) =>
  'string' === typeof req.query[key] ? req.query[key] : undefined;

/**
 * Alex hack: SCIM 2.0 endpoint for Pocket ID provisioning, at /api/scim/v2 (paths outside /api
 * are locale-redirected). Off unless SCIM_TOKEN is set. See src/server/scim.ts.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!env.SCIM_TOKEN) {
    return res.status(404).end();
  }
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if ('bearer' !== scheme?.toLowerCase() || !token || !keysMatch(token, env.SCIM_TOKEN)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return send(res, 401, scimErrorBody(401, 'Invalid or missing bearer token'));
  }

  const path = Array.isArray(req.query.path) ? req.query.path : [];
  const [resource, id, ...rest] = path;
  const provider = oidcProviderId();

  try {
    if ('Users' === resource && !id) {
      if ('GET' === req.method) {
        return send(
          res,
          200,
          await listUsers(db, provider, query(req, 'startIndex'), query(req, 'count')),
        );
      }
      if ('POST' === req.method) {
        return send(res, 201, await createUser(db, provider, await readJson(req)));
      }
      return notAllowed(res, 'GET, POST');
    }
    if ('Users' === resource && id && 0 === rest.length) {
      if ('GET' === req.method) {
        return send(res, 200, await getUser(db, provider, id));
      }
      if ('PUT' === req.method) {
        return send(res, 200, await replaceUser(db, provider, id, await readJson(req)));
      }
      if ('DELETE' === req.method) {
        // Removals are ignored: the Split Pro account and its history stay.
        return send(res, 204);
      }
      return notAllowed(res, 'GET, PUT, DELETE');
    }
    if ('Groups' === resource && !id) {
      if ('GET' === req.method) {
        return send(res, 200, listResponse([], 0, pageParams(query(req, 'startIndex')).start));
      }
      if ('POST' === req.method) {
        return send(res, 201, echoGroup(await readJson(req)));
      }
      return notAllowed(res, 'GET, POST');
    }
    if ('Groups' === resource && id && 0 === rest.length) {
      if ('PUT' === req.method) {
        return send(res, 200, echoGroup(await readJson(req), id));
      }
      if ('DELETE' === req.method) {
        return send(res, 204);
      }
      if ('GET' === req.method) {
        return send(res, 404, scimErrorBody(404, `Group ${id} not found`));
      }
      return notAllowed(res, 'GET, PUT, DELETE');
    }
    return send(res, 404, scimErrorBody(404, 'Not found'));
  } catch (error) {
    if (error instanceof ScimError) {
      return send(res, error.status, scimErrorBody(error.status, error.message, error.scimType));
    }
    console.error('SCIM request failed', error);
    return send(res, 500, scimErrorBody(500, 'Internal error'));
  }
}
