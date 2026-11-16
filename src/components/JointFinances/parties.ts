import type { User } from '@prisma/client';

import {
  type Households,
  type PartyBalance,
  householdIndex,
  householdPartyId,
  isHouseholdParty,
} from '~/lib/jointFinances';

/** Alex hack: someone settling up in a group with joint finances — a person or a household. */
export interface Party {
  id: number;
  members: User[];
  household: boolean;
}

/** Households first, then everyone not in one. */
export const buildParties = (users: User[], households: Households): Party[] => {
  const byId = new Map(users.map((user) => [user.id, user]));
  const inHousehold = new Set(households.flat());
  return [
    ...households.map((household, index) => ({
      id: householdPartyId(index),
      members: household.flatMap((id) => byId.get(id) ?? []),
      household: true,
    })),
    ...users
      .filter((user) => !inHousehold.has(user.id))
      .map((user) => ({ id: user.id, members: [user], household: false })),
  ];
};

export const findParty = (parties: Party[], partyId: number) =>
  parties.find((party) => party.id === partyId);

/** "Alex & Sam", "Alex, Sam & Jo"; the viewer comes first as `you`. */
export const partyName = (
  party: Party,
  displayName: (user: User) => string,
  meId: number | undefined,
  you: string,
) => {
  const members = [...party.members].sort((a, b) => Number(b.id === meId) - Number(a.id === meId));
  const names = members.map((member) => (member.id === meId ? you : displayName(member)));
  return 2 >= names.length
    ? names.join(' & ')
    : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
};

export const includesUser = (party: Party, userId: number | undefined) =>
  party.members.some((member) => member.id === userId);

/** Each party's total per currency (positive = owed to them). */
export const partyTotals = (balances: PartyBalance[]) =>
  balances.reduce<Record<number, Record<string, bigint>>>((acc, balance) => {
    acc[balance.partyId] ??= {};
    const totals = acc[balance.partyId]!;
    totals[balance.currency] = (totals[balance.currency] ?? 0n) + balance.amount;
    return acc;
  }, {});

/** Equal parts that add up exactly; leftover pennies go to the first parts. */
export const splitEqually = (amount: bigint, parts: number): bigint[] => {
  const each = amount / BigInt(parts);
  const remainder = amount - each * BigInt(parts);
  return Array.from({ length: parts }, (_, index) => each + (BigInt(index) < remainder ? 1n : 0n));
};

export interface SettlementPart {
  payer: User;
  receiver: User;
  amount: bigint;
}

/**
 * Ordinary two-person settlements for a payment between parties: split equally across all the
 * chosen payers (a joint account) and then across all the chosen receivers.
 */
export const settlementParts = (
  amount: bigint,
  payers: User[],
  receivers: User[],
): SettlementPart[] =>
  splitEqually(amount, payers.length).flatMap((payerAmount, payerIndex) =>
    splitEqually(payerAmount, receivers.length)
      .map((partAmount, receiverIndex) => ({
        payer: payers[payerIndex]!,
        receiver: receivers[receiverIndex]!,
        amount: partAmount,
      }))
      .filter((part) => 0n < part.amount),
  );

export { householdIndex, isHouseholdParty };
