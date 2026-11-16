import { type Prisma } from '@prisma/client';
import { z } from 'zod';

import { type Households } from '~/lib/jointFinances';

/**
 * Alex hack: households live in the existing AppMetadata key-value table (no schema change),
 * one key per group. Plain Split Pro ignores these keys.
 */
const key = (groupId: number) => `alex-hacks:joint-finances:group:${groupId}`;

const storedHouseholds = z.array(z.array(z.number().int()));

type Db = Pick<Prisma.TransactionClient, 'appMetadata'>;

export const getHouseholds = async (db: Db, groupId: number): Promise<Households> => {
  const row = await db.appMetadata.findUnique({ where: { key: key(groupId) } });
  if (!row) {
    return [];
  }
  try {
    const parsed = storedHouseholds.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
};

export const setHouseholds = async (db: Db, groupId: number, households: Households) => {
  if (0 === households.length) {
    await db.appMetadata.deleteMany({ where: { key: key(groupId) } });
    return;
  }
  const value = JSON.stringify(households);
  await db.appMetadata.upsert({
    where: { key: key(groupId) },
    create: { key: key(groupId), value },
    update: { value },
  });
};
