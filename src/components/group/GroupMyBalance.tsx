import { type BalanceView, type User } from '@prisma/client';
import React, { useMemo } from 'react';

import { CumulatedBalances } from '~/components/Expense/CumulatedBalances';
import { buildParties, partyName } from '~/components/JointFinances/parties';
import { useTranslationWithUtils } from '~/hooks/useTranslationWithUtils';
import { type JointFinances, partyOf } from '~/lib/jointFinances';
import { BigMath } from '~/utils/numbers';

interface GroupMyBalanceProps {
  userId: number;
  groupBalances?: BalanceView[];
  users?: User[];
  groupId: number;
  jointFinances?: JointFinances;
}

const GroupMyBalance: React.FC<GroupMyBalanceProps> = ({
  userId,
  groupBalances = [],
  users = [],
  groupId,
  jointFinances,
}) => {
  const { t, displayName, getCurrencyHelpersCached } = useTranslationWithUtils();

  const userMap = useMemo(
    () =>
      users.reduce<Record<number, User>>((acc, user) => {
        acc[user.id] = user;
        return acc;
      }, {}),
    [users],
  );

  // Alex hack: with joint finances, balances are between parties (people or households), and
  // "mine" are my household's. Party ids double as friend keys (households are negative).
  const joint = jointFinances?.active ? jointFinances : undefined;
  const parties = useMemo(
    () => (joint ? buildParties(users, joint.households) : []),
    [joint, users],
  );
  const rows = useMemo(
    () =>
      joint
        ? joint.balances.map((b) => ({
            userId: b.partyId,
            friendId: b.friendPartyId,
            currency: b.currency,
            amount: b.amount,
          }))
        : groupBalances,
    [joint, groupBalances],
  );
  const myId = joint ? partyOf(joint.households)(userId) : userId;

  const friendBalances = useMemo(
    () =>
      rows.reduce<Record<number, Record<string, bigint>>>((acc, balance) => {
        if (balance.userId === myId && 0 < BigMath.abs(balance.amount)) {
          acc[balance.friendId] ??= {};
          const friendBalance = acc[balance.friendId]!;
          friendBalance[balance.currency] =
            (friendBalance[balance.currency] ?? 0n) + balance.amount;
        }
        return acc;
      }, {}),
    [rows, myId],
  );

  const cumulatedBalances = useMemo(
    () =>
      Object.entries(
        Object.values(friendBalances).reduce<Record<string, bigint>>((acc, balances) => {
          if (balances) {
            Object.entries(balances).forEach(([currency, amount]) => {
              acc[currency] = (acc[currency] ?? 0n) + amount;
            });
          }
          return acc;
        }, {}),
      ).map(([currency, amount]) => ({ currency, amount })),
    [friendBalances],
  );

  return (
    <div className="flex gap-2">
      <div className="flex flex-col gap-2">
        <CumulatedBalances entityId={groupId} entityType="group" balances={cumulatedBalances} />

        {Object.entries(friendBalances)
          .slice(0, 2)
          .map(([friendId, balances]) => {
            const friend = userMap[+friendId];
            const household = parties.find((party) => party.household && party.id === +friendId);
            const friendName = household
              ? partyName(household, displayName, userId, t('actors.you'))
              : displayName(friend);
            return (
              <div key={friendId} className="text-sm text-gray-500">
                {Object.entries(balances).map(([currency, amount]) => (
                  <div key={currency}>
                    {t(
                      0 < amount
                        ? household
                          ? 'joint_finances.household_owes_you'
                          : 'balance_summary.friend_owes_you'
                        : 'balance_summary.you_owe_friend',
                      {
                        friend: friendName,
                        amount: getCurrencyHelpersCached(currency).toUIString(amount),
                      },
                    )}
                  </div>
                ))}
              </div>
            );
          })}

        {2 < Object.keys(friendBalances).length ? (
          <div className="text-sm text-gray-500">
            {t('balance_summary.more', { count: Object.keys(friendBalances).length - 2 })}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default GroupMyBalance;
