import { type Mutation } from '@tanstack/react-query';

import { isQueueable } from '~/components/Offline/offlineQueue';

const mutation = (path: string[], variables: unknown) =>
  ({ options: { mutationKey: [path] }, state: { variables } }) as unknown as Mutation;

describe('isQueueable', () => {
  it('queues new expenses and settle-ups', () => {
    expect(isQueueable(mutation(['expense', 'addOrEditExpense'], [{ name: 'Lunch' }]))).toBe(true);
    expect(
      isQueueable(mutation(['expense', 'addOrEditExpense'], [{ name: 'A' }, { name: 'B' }])),
    ).toBe(true);
  });

  it('does not queue edits or anything else', () => {
    expect(
      isQueueable(mutation(['expense', 'addOrEditExpense'], [{ name: 'Lunch', expenseId: 'e1' }])),
    ).toBe(false);
    expect(isQueueable(mutation(['group', 'create'], { name: 'Trip' }))).toBe(false);
    expect(isQueueable(mutation(['expense', 'deleteExpense'], { expenseId: 'e1' }))).toBe(false);
  });
});
