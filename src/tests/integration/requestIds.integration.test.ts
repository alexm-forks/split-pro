import { requestKey } from '~/server/requestIds';

import { db } from './database';
import { expenseInput, testGroup, testUser } from './factories';
import { callerFor } from './trpc';

describe('request ids (exactly-once writes)', () => {
  it('returns the original expense when a request is retried', async () => {
    const alex = await testUser('Alex');
    const sam = await testUser('Sam');
    const input = { ...expenseInput(alex.id, sam.id), requestId: 'req-1' };

    const [first] = await callerFor(alex.id).expense.addOrEditExpense(input);
    const [retry] = await callerFor(alex.id).expense.addOrEditExpense(input);

    expect(retry?.id).toBe(first?.id);
    expect(await db.expense.count()).toBe(1);
    expect(
      await db.appMetadata.findUnique({ where: { key: requestKey(alex.id, 'expense', 'req-1') } }),
    ).toMatchObject({
      value: first?.id,
    });
  });

  it('creates once when the same request arrives twice at the same time', async () => {
    const alex = await testUser('Alex');
    const sam = await testUser('Sam');
    const input = { ...expenseInput(alex.id, sam.id), requestId: 'req-2' };

    const results = await Promise.allSettled([
      callerFor(alex.id).expense.addOrEditExpense(input),
      callerFor(alex.id).expense.addOrEditExpense(input),
    ]);

    expect(await db.expense.count()).toBe(1);
    // The other copy either got the same expense back or was told it's still in progress.
    results.forEach((result) => {
      if ('rejected' === result.status) {
        expect(result.reason).toMatchObject({ code: 'CONFLICT' });
      }
    });
  });

  it('keeps settlements in one batch separate, and still creates without a request id', async () => {
    const alex = await testUser('Alex');
    const sam = await testUser('Sam');
    const jo = await testUser('Jo');
    const batch = [
      { ...expenseInput(alex.id, jo.id), requestId: 'settle-a' },
      { ...expenseInput(sam.id, jo.id), requestId: 'settle-b' },
    ];
    await callerFor(alex.id).expense.addOrEditExpense(batch);
    await callerFor(alex.id).expense.addOrEditExpense(batch);
    expect(await db.expense.count()).toBe(2);

    const plain = expenseInput(alex.id, sam.id);
    await callerFor(alex.id).expense.addOrEditExpense(plain);
    await callerFor(alex.id).expense.addOrEditExpense(plain);
    expect(await db.expense.count()).toBe(4);
  });

  it('lets a failed request be retried', async () => {
    const alex = await testUser('Alex');
    const sam = await testUser('Sam');
    const outsider = await testUser('Outsider');
    const group = await testGroup(outsider.id);
    // Not a member of the group: refused, and the request id is released.
    const refused = { ...expenseInput(alex.id, sam.id, { groupId: group.id }), requestId: 'req-3' };
    await expect(callerFor(alex.id).expense.addOrEditExpense(refused)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await db.appMetadata.count()).toBe(0);

    const fixed = { ...expenseInput(alex.id, sam.id), requestId: 'req-3' };
    await callerFor(alex.id).expense.addOrEditExpense(fixed);
    expect(await db.expense.count()).toBe(1);
  });

  it('scopes request ids per user', async () => {
    const alex = await testUser('Alex');
    const sam = await testUser('Sam');
    await callerFor(alex.id).expense.addOrEditExpense({
      ...expenseInput(alex.id, sam.id),
      requestId: 'same',
    });
    await callerFor(sam.id).expense.addOrEditExpense({
      ...expenseInput(sam.id, alex.id),
      requestId: 'same',
    });
    expect(await db.expense.count()).toBe(2);
  });

  it('takes over a claim abandoned by a crash', async () => {
    const alex = await testUser('Alex');
    const sam = await testUser('Sam');
    await db.appMetadata.create({
      data: { key: requestKey(alex.id, 'expense', 'req-4'), value: 'pending' },
    });
    const input = { ...expenseInput(alex.id, sam.id), requestId: 'req-4' };
    // Still fresh: treated as in progress.
    await expect(callerFor(alex.id).expense.addOrEditExpense(input)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await db.$executeRaw`UPDATE "AppMetadata" SET "updatedAt" = now() - interval '10 minutes'`;
    const [created] = await callerFor(alex.id).expense.addOrEditExpense(input);
    expect(created?.id).toBeDefined();
    expect(await db.expense.count()).toBe(1);
  });

  it('creates a group once per request id', async () => {
    const alex = await testUser('Alex');
    const first = await callerFor(alex.id).group.create({ name: 'Trip', requestId: 'g-1' });
    const retry = await callerFor(alex.id).group.create({ name: 'Trip', requestId: 'g-1' });
    expect(retry?.id).toBe(first?.id);
    expect(await db.group.count()).toBe(1);
    await callerFor(alex.id).group.create({ name: 'Trip' });
    expect(await db.group.count()).toBe(2);
  });
});
