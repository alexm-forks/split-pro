import { Prisma, type PrismaClient } from '@prisma/client';
import { TRPCError } from '@trpc/server';

/**
 * Alex hack: exactly-once writes on patchy connections. The app sends a request id with each
 * action (the same id on every retry of it); the first request claims the id and records what it
 * created, and a repeat gets that original result back instead of creating it again.
 *
 * Ids live in the existing AppMetadata key-value table (no schema change), keyed per user.
 */
const PREFIX = 'alex-hacks:request:';
const PENDING = 'pending';
/** A claim this old whose request never finished (e.g. a crash) may be taken over. */
const STALE_CLAIM_MS = 2 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type Db = Pick<PrismaClient, 'appMetadata'>;

export const requestKey = (userId: number, scope: string, requestId: string) =>
  `${PREFIX}${userId}:${scope}:${requestId}`;

const claim = async (db: Db, key: string) => {
  try {
    await db.appMetadata.create({ data: { key, value: PENDING } });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && 'P2002' === error.code) {
      return false;
    }
    throw error;
  }
};

const inProgress = () =>
  new TRPCError({ code: 'CONFLICT', message: 'This request is still being processed' });

/** Occasionally drop ids older than the retention period, so the table stays small. */
const maybeCleanUp = (db: Db) => {
  if (0.02 < Math.random()) {
    return;
  }
  db.appMetadata
    .deleteMany({
      where: {
        key: { startsWith: PREFIX },
        createdAt: { lt: new Date(Date.now() - RETENTION_MS) },
      },
    })
    .catch((error: unknown) => console.error('Failed to clean up request ids', error));
};

/**
 * Run `run` at most once per (user, scope, requestId). Without a requestId it just runs.
 * `resultId` names what was created, and `replay` loads it again for a repeated request.
 */
export const runOnce = async <T>(
  db: Db,
  { userId, scope, requestId }: { userId: number; scope: string; requestId?: string },
  run: () => Promise<T>,
  resultId: (result: T) => string,
  replay: (id: string) => Promise<T | null>,
): Promise<T> => {
  if (!requestId) {
    return run();
  }
  const key = requestKey(userId, scope, requestId);
  maybeCleanUp(db);

  if (!(await claim(db, key))) {
    const existing = await db.appMetadata.findUnique({ where: { key } });
    if (existing && PENDING !== existing.value) {
      const replayed = await replay(existing.value);
      if (null !== replayed) {
        return replayed;
      }
    }
    if (existing && PENDING === existing.value) {
      if (Date.now() - existing.updatedAt.getTime() < STALE_CLAIM_MS) {
        throw inProgress();
      }
    }
    // A stale claim, or a result that no longer exists: take the id over.
    if (existing) {
      await db.appMetadata.deleteMany({ where: { key, value: existing.value } });
    }
    if (!(await claim(db, key))) {
      throw inProgress();
    }
  }

  try {
    const result = await run();
    await db.appMetadata.update({ where: { key }, data: { value: resultId(result) } });
    return result;
  } catch (error) {
    await db.appMetadata.deleteMany({ where: { key, value: PENDING } }).catch(() => undefined);
    throw error;
  }
};
