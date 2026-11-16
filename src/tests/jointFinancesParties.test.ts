import type { User } from '@prisma/client';

import {
  buildParties,
  partyName,
  settlementParts,
  splitEqually,
} from '~/components/JointFinances/parties';
import { householdPartyId } from '~/lib/jointFinances';

const user = (id: number, name: string) => ({ id, name }) as User;
const ALEX = user(1, 'Alex');
const SAM = user(2, 'Sam');
const JO = user(3, 'Jo');
const KIM = user(4, 'Kim');
const name = (u: User) => u.name ?? '';

describe('joint finances parties', () => {
  it('builds households first, then everyone else', () => {
    const parties = buildParties([ALEX, SAM, JO, KIM], [[ALEX.id, SAM.id, KIM.id]]);
    expect(parties.map((p) => [p.id, p.members.map((m) => m.id), p.household])).toEqual([
      [householdPartyId(0), [1, 2, 4], true],
      [3, [3], false],
    ]);
  });

  it('names households, putting the viewer first as You', () => {
    const [couple] = buildParties([ALEX, SAM], [[ALEX.id, SAM.id]]);
    const [three] = buildParties([ALEX, SAM, KIM], [[ALEX.id, SAM.id, KIM.id]]);
    expect(partyName(couple!, name, undefined, 'You')).toBe('Alex & Sam');
    expect(partyName(couple!, name, SAM.id, 'You')).toBe('You & Alex');
    expect(partyName(three!, name, undefined, 'You')).toBe('Alex, Sam & Kim');
  });

  it('splits equally to the penny', () => {
    expect(splitEqually(1000n, 3)).toEqual([334n, 333n, 333n]);
    expect(splitEqually(1000n, 1)).toEqual([1000n]);
  });

  it('records one settlement for a chosen member', () => {
    expect(settlementParts(3000n, [JO], [SAM])).toEqual([
      { payer: JO, receiver: SAM, amount: 3000n },
    ]);
  });

  it('records a joint-account payment as one equal settlement per member', () => {
    expect(settlementParts(3000n, [JO], [ALEX, SAM])).toEqual([
      { payer: JO, receiver: ALEX, amount: 1500n },
      { payer: JO, receiver: SAM, amount: 1500n },
    ]);
    const fromThree = settlementParts(1000n, [ALEX, SAM, KIM], [JO]);
    expect(fromThree.map((p) => [p.payer.id, p.amount])).toEqual([
      [1, 334n],
      [2, 333n],
      [4, 333n],
    ]);
  });

  it('splits across both sides when two joint accounts settle', () => {
    const parts = settlementParts(1000n, [ALEX, SAM], [JO, KIM]);
    expect(parts).toHaveLength(4);
    expect(parts.reduce((sum, p) => sum + p.amount, 0n)).toBe(1000n);
  });

  it('records nothing for a zero amount', () => {
    expect(settlementParts(0n, [ALEX, SAM], [JO])).toEqual([]);
  });
});
