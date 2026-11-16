import type { User } from '@prisma/client';
import { clsx } from 'clsx';
import React from 'react';

import { EntityAvatar } from '~/components/ui/avatar';
import { useTranslationWithUtils } from '~/hooks/useTranslationWithUtils';
import { type JointFinances } from '~/lib/jointFinances';
import { api } from '~/utils/api';
import { BigMath } from '~/utils/numbers';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../ui/accordion';
import { Button } from '../ui/button';
import { SettleupIcon } from '../ui/categoryIcons';
import { JointSettleUp } from './JointSettleUp';
import {
  type Party,
  buildParties,
  findParty,
  includesUser,
  partyName,
  partyTotals,
} from './parties';

const PartyAvatar: React.FC<{ party: Party; size?: number }> = ({ party, size }) => (
  <div className="flex -space-x-2">
    {party.members.slice(0, 2).map((member) => (
      <EntityAvatar key={member.id} entity={member} size={size} />
    ))}
  </div>
);

/** The currency with the largest balance, for the summary line. */
const largest = (totals: Record<string, bigint>): [string, bigint] =>
  Object.entries(totals).reduce<[string, bigint]>(
    (best, entry) => (BigMath.abs(entry[1]) > BigMath.abs(best[1]) ? entry : best),
    ['', 0n],
  );

/**
 * Alex hack: the group's balances with households (joint finances) shown as one party each,
 * expandable to each member's own share. Replaces BalanceList while joint finances are active.
 */
export const JointBalanceList: React.FC<{
  jointFinances: JointFinances;
  users: User[];
  groupId: number;
}> = ({ jointFinances, users, groupId }) => {
  const { displayName, t, getCurrencyHelpersCached } = useTranslationWithUtils();
  const meId = api.user.me.useQuery().data?.id;
  const you = t('actors.you');

  const parties = buildParties(users, jointFinances.households);
  const totals = partyTotals(jointFinances.balances);
  const money = (currency: string, amount: bigint) =>
    getCurrencyHelpersCached(currency).toUIString(BigMath.abs(amount));
  const name = (party: Party) => partyName(party, displayName, meId, you);
  // A household, or "You", takes the plural verb.
  const plural = (party: Party) => party.household || includesUser(party, meId);

  return (
    <Accordion type="multiple">
      {parties.map((party) => {
        const partyTotal = totals[party.id] ?? {};
        const [currency, amount] = largest(partyTotal);
        const settled = Object.values(partyTotal).every((value) => 0n === value);
        const isMe = !party.household && includesUser(party, meId);
        const summary = settled
          ? party.household
            ? t('joint_finances.settled', { party: name(party) })
            : t('expense_details.balance_list.settled', {
                actor: isMe ? 'you' : 'other',
                person: name(party),
              })
          : party.household
            ? t(`joint_finances.${0 < amount ? 'lent' : 'owes'}`, { party: name(party) })
            : t(`expense_details.balance_list.${0 < amount ? 'lent' : 'owes'}`, {
                actor: isMe ? 'you' : 'other',
                person: name(party),
              });
        const lines = jointFinances.balances.filter(
          (balance) => balance.partyId === party.id && 0n !== balance.amount,
        );
        const shares = jointFinances.memberShares.filter((share) =>
          party.members.some((member) => member.id === share.userId),
        );

        return (
          <AccordionItem key={party.id} value={String(party.id)}>
            <AccordionTrigger className="overflow-hidden hover:no-underline">
              <div className="mr-2 flex min-w-0 flex-1 items-center gap-3">
                <PartyAvatar party={party} />
                <div className="text-foreground line-clamp-2 min-w-0 break-words">
                  <span className="text-gray-400">{summary} </span>
                  {settled ? null : (
                    <span
                      className={clsx(
                        'text-right',
                        0 < amount ? 'text-emerald-500' : 'text-orange-600',
                      )}
                    >
                      {money(currency, amount)}
                    </span>
                  )}
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent>
              {party.household && 0 < shares.length ? (
                <div className="border-t-2 py-2">
                  <p className="ml-5 text-xs text-gray-500">{t('joint_finances.own_shares')}</p>
                  {party.members.map((member) =>
                    shares
                      .filter((share) => share.userId === member.id && 0n !== share.amount)
                      .map((share) => (
                        <div
                          key={`${member.id}-${share.currency}`}
                          className="ml-5 flex items-center gap-3 py-1 text-sm"
                        >
                          <EntityAvatar entity={member} size={20} />
                          <span className="text-gray-400">
                            {t(
                              `expense_details.balance_list.${0 < share.amount ? 'lent' : 'owes'}`,
                              {
                                actor: member.id === meId ? 'you' : 'other',
                                person: displayName(member),
                              },
                            )}
                          </span>
                          <span
                            className={0 < share.amount ? 'text-emerald-500' : 'text-orange-600'}
                          >
                            {money(share.currency, share.amount)}
                          </span>
                        </div>
                      )),
                  )}
                </div>
              ) : null}
              {lines.map((balance) => {
                const friend = findParty(parties, balance.friendPartyId);
                if (!friend) {
                  return null;
                }
                // Positive: the friend party owes this party.
                const payer = 0 < balance.amount ? friend : party;
                const receiver = 0 < balance.amount ? party : friend;
                return (
                  <div
                    key={`${balance.friendPartyId}-${balance.currency}`}
                    className="flex h-12 w-full items-center justify-between border-t-2"
                  >
                    <div className="ml-5 flex items-center gap-3 text-sm">
                      <PartyAvatar party={friend} size={20} />
                      <div className="text-foreground">
                        {t('joint_finances.pays', {
                          payer: name(payer),
                          plural: plural(payer) ? 'yes' : 'no',
                          receiver: name(receiver).replace(you, you.toLowerCase()),
                          amount: money(balance.currency, balance.amount),
                        })}
                      </div>
                    </div>
                    <JointSettleUp
                      amount={balance.amount}
                      currency={balance.currency}
                      payer={payer}
                      receiver={receiver}
                      groupId={groupId}
                    >
                      <Button size="icon" variant="secondary" className="size-8">
                        <SettleupIcon className="size-4" />
                      </Button>
                    </JointSettleUp>
                  </div>
                );
              })}
            </AccordionContent>
          </AccordionItem>
        );
      })}
    </Accordion>
  );
};
