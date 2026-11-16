import type { BalanceView } from '@prisma/client';

import {
  type PartyBalance,
  computeJointFinances,
  householdPartyId,
  normaliseHouseholds,
} from '~/lib/jointFinances';

const ALEX = 1;
const SAM = 2;
const JO = 3;
const KIM = 4;
const LEE = 5;
const HOUSEHOLD = householdPartyId(0);

/** BalanceView rows, both directions, for [debtor, creditor, amount] debts in one group. */
const rows = (debts: [number, number, bigint, string?][]): BalanceView[] =>
  debts.flatMap(([debtor, creditor, amount, currency = 'GBP']) => [
    { userId: creditor, friendId: debtor, groupId: 7, currency, amount } as BalanceView,
    { userId: debtor, friendId: creditor, groupId: 7, currency, amount: -amount } as BalanceView,
  ]);

/** Each party's net per currency (positive = owed to them). */
const nets = (balances: PartyBalance[]) =>
  balances.reduce<Record<string, bigint>>((acc, { partyId, currency, amount }) => {
    const key = `${partyId}:${currency}`;
    acc[key] = (acc[key] ?? 0n) + amount;
    return acc;
  }, {});

describe('computeJointFinances', () => {
  it('is inactive without simplify debts or without households', () => {
    const raw = rows([[ALEX, JO, 5000n]]);
    expect(computeJointFinances(raw, [[ALEX, SAM]], false)).toMatchObject({
      active: false,
      balances: [],
    });
    expect(computeJointFinances(raw, [], true)).toMatchObject({ active: false, balances: [] });
  });

  it('settles a couple jointly: Alex owes Jo 50, Jo owes Sam 20, so Alex & Sam owe Jo 30', () => {
    const joint = computeJointFinances(
      rows([
        [ALEX, JO, 5000n],
        [JO, SAM, 2000n],
      ]),
      [[ALEX, SAM]],
      true,
    );
    expect(joint.active).toBe(true);
    expect(joint.balances).toHaveLength(2);
    expect(joint.balances).toEqual(
      expect.arrayContaining([
        { partyId: JO, friendPartyId: HOUSEHOLD, currency: 'GBP', amount: 3000n },
        { partyId: HOUSEHOLD, friendPartyId: JO, currency: 'GBP', amount: -3000n },
      ]),
    );
    expect(joint.memberShares).toEqual(
      expect.arrayContaining([
        { userId: ALEX, currency: 'GBP', amount: -5000n },
        { userId: SAM, currency: 'GBP', amount: 2000n },
      ]),
    );
  });

  it('ignores what household members owe each other', () => {
    const joint = computeJointFinances(
      rows([
        [ALEX, SAM, 1000n],
        [ALEX, JO, 5000n],
        [JO, SAM, 2000n],
      ]),
      [[ALEX, SAM]],
      true,
    );
    expect(nets(joint.balances)).toEqual({ [`${HOUSEHOLD}:GBP`]: -3000n, [`${JO}:GBP`]: 3000n });
    // Own shares only count people outside the household.
    expect(joint.memberShares).toEqual(
      expect.arrayContaining([
        { userId: ALEX, currency: 'GBP', amount: -5000n },
        { userId: SAM, currency: 'GBP', amount: 2000n },
      ]),
    );
  });

  it('owes nothing at all when only household members are involved', () => {
    expect(computeJointFinances(rows([[ALEX, SAM, 1000n]]), [[ALEX, SAM]], true).balances).toEqual(
      [],
    );
  });

  it('handles households of three, keeping the household net equal to its members’ own shares', () => {
    const joint = computeJointFinances(
      rows([
        [ALEX, KIM, 3000n],
        [SAM, LEE, 1200n],
        [KIM, JO, 900n],
        [LEE, ALEX, 400n],
        [JO, SAM, 100n],
      ]),
      [[ALEX, SAM, JO]],
      true,
    );
    const partyNets = nets(joint.balances);
    const memberTotal = joint.memberShares.reduce((sum, share) => sum + share.amount, 0n);
    // Alex -3000 +400, Sam -1200, Jo +900; Jo owing Sam 100 is inside the household.
    expect(memberTotal).toBe(-2900n);
    expect(partyNets[`${HOUSEHOLD}:GBP`]).toBe(-2900n);
    expect(Object.values(partyNets).reduce((sum, amount) => sum + amount, 0n)).toBe(0n);
    expect(joint.balances.every((b) => b.partyId !== b.friendPartyId)).toBe(true);
  });

  it('keeps currencies separate', () => {
    const joint = computeJointFinances(
      rows([
        [ALEX, JO, 1000n, 'GBP'],
        [SAM, JO, 500n, 'EUR'],
      ]),
      [[ALEX, SAM]],
      true,
    );
    expect(nets(joint.balances)).toEqual({
      [`${HOUSEHOLD}:GBP`]: -1000n,
      [`${JO}:GBP`]: 1000n,
      [`${HOUSEHOLD}:EUR`]: -500n,
      [`${JO}:EUR`]: 500n,
    });
  });
});

describe('normaliseHouseholds', () => {
  it('keeps current members only, once each, in households of two or more', () => {
    expect(
      normaliseHouseholds(
        [
          [ALEX, SAM, 99],
          [SAM, JO],
          [KIM, KIM, LEE],
        ],
        [ALEX, SAM, JO, KIM, LEE],
      ),
    ).toEqual([
      [ALEX, SAM],
      [KIM, LEE],
    ]);
  });
});
