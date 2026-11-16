import type { BalanceView } from '@prisma/client';

import { simplifyDebts } from '~/lib/simplify';

/**
 * Alex hack: joint finances. Within a group, people marked as a household (any number of them)
 * never owe each other, and the household settles with everyone else as one party. It only
 * applies while the group simplifies debts: each household is then one node in the
 * simplification. Expenses and the per-person balances are untouched; this is a view over them.
 */

/** A household is a list of user ids; a party is a user or a household. */
export type Households = number[][];

/** Party ids: a user's own id, or -(index + 1) for the household at that index. */
export const householdPartyId = (index: number) => -(index + 1);
export const isHouseholdParty = (partyId: number) => 0 > partyId;
export const householdIndex = (partyId: number) => -partyId - 1;

export interface PartyBalance {
  partyId: number;
  friendPartyId: number;
  currency: string;
  /** Positive: friendParty owes party. Every pair appears in both directions, mirrored. */
  amount: bigint;
}

export interface JointFinances {
  households: Households;
  /** True when households exist and the group simplifies debts. */
  active: boolean;
  /** Simplified balances between parties (empty unless active). */
  balances: PartyBalance[];
  /** Each household member's own net with people outside their household, per currency. */
  memberShares: { userId: number; currency: string; amount: bigint }[];
}

/**
 * Keep only current members, drop duplicates and anyone already in an earlier household, and
 * drop households left with fewer than two people.
 */
export const normaliseHouseholds = (households: Households, memberIds: number[]): Households => {
  const members = new Set(memberIds);
  const placed = new Set<number>();
  return households
    .map((household) =>
      household.filter((id) => {
        if (!members.has(id) || placed.has(id)) {
          return false;
        }
        placed.add(id);
        return true;
      }),
    )
    .filter((household) => 2 <= household.length);
};

export const partyOf = (households: Households) => {
  const byUser = new Map<number, number>();
  households.forEach((household, index) =>
    household.forEach((userId) => byUser.set(userId, householdPartyId(index))),
  );
  return (userId: number) => byUser.get(userId) ?? userId;
};

/**
 * Joint balances for a group from its raw (unsimplified) balance rows. Rows between members of
 * the same household are dropped; the rest are summed per party pair and simplified.
 */
export const computeJointFinances = (
  rawBalances: BalanceView[],
  households: Households,
  simplify: boolean,
): JointFinances => {
  const active = simplify && 0 < households.length;
  if (!active) {
    return { households, active, balances: [], memberShares: [] };
  }
  const party = partyOf(households);

  // Sum both directions per party pair; the result stays mirrored like BalanceView.
  const sums = new Map<string, BalanceView>();
  const shares = new Map<string, { userId: number; currency: string; amount: bigint }>();
  rawBalances.forEach((row) => {
    const from = party(row.userId);
    const to = party(row.friendId);
    if (from === to) {
      return; // Members of one household never owe each other.
    }
    const key = `${from}:${to}:${row.currency}`;
    const sum = sums.get(key);
    if (sum) {
      sum.amount += row.amount;
    } else {
      sums.set(key, { ...row, userId: from, friendId: to, amount: row.amount });
    }
    if (isHouseholdParty(from)) {
      const shareKey = `${row.userId}:${row.currency}`;
      const share = shares.get(shareKey);
      if (share) {
        share.amount += row.amount;
      } else {
        shares.set(shareKey, { userId: row.userId, currency: row.currency, amount: row.amount });
      }
    }
  });

  const balances = simplifyDebts([...sums.values()])
    .filter((balance) => 0n !== balance.amount)
    .map(({ userId, friendId, currency, amount }) => ({
      partyId: userId,
      friendPartyId: friendId,
      currency,
      amount,
    }));

  return { households, active, balances, memberShares: [...shares.values()] };
};
