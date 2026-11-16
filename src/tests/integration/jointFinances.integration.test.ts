import { householdPartyId } from '~/lib/jointFinances';

import { db } from './database';
import { expenseInput, testGroup, testUser } from './factories';
import { callerFor } from './trpc';

const scenario = async ({ simplifyDebts = true } = {}) => {
  const alex = await testUser('Alex');
  const sam = await testUser('Sam');
  const jo = await testUser('Jo');
  const outsider = await testUser('Outsider');
  const group = await createGroup(alex.id, [sam.id, jo.id], simplifyDebts);
  // Alex owes Jo 50, Jo owes Sam 20, Alex owes Sam 10: jointly Alex & Sam owe Jo 30.
  const add = (payer: number, participant: number, amount: bigint) =>
    callerFor(payer).expense.addOrEditExpense(
      expenseInput(payer, participant, { groupId: group.id, amount, currency: 'GBP' }),
    );
  await add(jo.id, alex.id, 10000n);
  await add(sam.id, jo.id, 4000n);
  await add(sam.id, alex.id, 2000n);
  return { alex, sam, jo, outsider, group };
};

const createGroup = async (ownerId: number, memberIds: number[], simplifyDebts: boolean) =>
  db.group.update({
    where: { id: (await testGroup(ownerId, memberIds)).id },
    data: { simplifyDebts },
  });

describe('joint finances', () => {
  it('settles a household jointly while leaving the per-person balances alone', async () => {
    const { alex, sam, jo, group } = await scenario();
    const before = await callerFor(jo.id).group.getGroupDetails({ groupId: group.id });
    expect(before?.jointFinances).toMatchObject({ households: [], active: false, balances: [] });

    await callerFor(jo.id).group.setJointFinances({
      groupId: group.id,
      households: [[alex.id, sam.id]],
    });
    const details = await callerFor(jo.id).group.getGroupDetails({ groupId: group.id });

    expect(details?.jointFinances.active).toBe(true);
    expect(details?.jointFinances.households).toEqual([[alex.id, sam.id]]);
    const household = householdPartyId(0);
    expect(
      details?.jointFinances.balances.map((b) => [b.partyId, b.friendPartyId, b.amount]),
    ).toEqual(
      expect.arrayContaining([
        [jo.id, household, 3000n],
        [household, jo.id, -3000n],
      ]),
    );
    expect(details?.jointFinances.balances).toHaveLength(2);
    // Own shares exclude the 10 Alex owes Sam inside the household.
    expect(
      Object.fromEntries(details!.jointFinances.memberShares.map((s) => [s.userId, s.amount])),
    ).toEqual({ [alex.id]: -5000n, [sam.id]: 2000n });
    // Upstream's groupBalances (used by the API and plain Split Pro) are unchanged.
    expect(details?.groupBalances).toEqual(before?.groupBalances);
    // Stored only as an AppMetadata row.
    expect(await db.appMetadata.findMany()).toEqual([
      expect.objectContaining({
        key: `alex-hacks:joint-finances:group:${group.id}`,
        value: JSON.stringify([[alex.id, sam.id]]),
      }),
    ]);
  });

  it('turns off while simplify debts is off, keeping the households', async () => {
    const { alex, sam, group } = await scenario({ simplifyDebts: false });
    await callerFor(alex.id).group.setJointFinances({
      groupId: group.id,
      households: [[alex.id, sam.id]],
    });
    const details = await callerFor(alex.id).group.getGroupDetails({ groupId: group.id });
    expect(details?.jointFinances).toMatchObject({
      households: [[alex.id, sam.id]],
      active: false,
      balances: [],
    });
  });

  it('records a joint-account settlement that clears the household', async () => {
    const { alex, sam, jo, group } = await scenario();
    await callerFor(alex.id).group.setJointFinances({
      groupId: group.id,
      households: [[alex.id, sam.id]],
    });
    // The household pays Jo 30 from its joint account: one settlement per member.
    const settle = (payer: number, amount: bigint) =>
      expenseInput(payer, jo.id, {
        groupId: group.id,
        amount,
        currency: 'GBP',
        splitType: 'SETTLEMENT',
        participants: [
          { userId: payer, amount },
          { userId: jo.id, amount: -amount },
        ],
      });
    await callerFor(alex.id).expense.addOrEditExpense([
      settle(alex.id, 1500n),
      settle(sam.id, 1500n),
    ]);

    const details = await callerFor(jo.id).group.getGroupDetails({ groupId: group.id });
    expect(details?.jointFinances.balances).toEqual([]);
  });

  it('refuses invalid households and outsiders', async () => {
    const { alex, sam, jo, outsider, group } = await scenario();
    const set = (households: number[][], by = alex.id) =>
      callerFor(by).group.setJointFinances({ groupId: group.id, households });

    await expect(set([[alex.id]])).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(set([[alex.id, outsider.id]])).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      set([
        [alex.id, sam.id],
        [sam.id, jo.id],
      ]),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(set([[alex.id, sam.id]], outsider.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // Three people can share finances; clearing removes the row.
    await expect(set([[alex.id, sam.id, jo.id]])).resolves.toEqual([[alex.id, sam.id, jo.id]]);
    await set([]);
    expect(await db.appMetadata.count()).toBe(0);
  });

  it('ignores people who have left the group', async () => {
    const { alex, sam, jo, group } = await scenario();
    await callerFor(alex.id).group.setJointFinances({
      groupId: group.id,
      households: [[alex.id, sam.id, jo.id]],
    });
    await db.groupUser.delete({ where: { groupId_userId: { groupId: group.id, userId: jo.id } } });
    const details = await callerFor(alex.id).group.getGroupDetails({ groupId: group.id });
    expect(details?.jointFinances.households).toEqual([[alex.id, sam.id]]);
  });
});
