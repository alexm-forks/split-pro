import { SplitType, type User } from '@prisma/client';
import { ArrowRightIcon } from 'lucide-react';
import { useSession } from 'next-auth/react';
import React, { type ReactNode, useState } from 'react';
import { toast } from 'sonner';

import { useTranslationWithUtils } from '~/hooks/useTranslationWithUtils';
import { DEFAULT_CATEGORY } from '~/lib/category';
import { api } from '~/utils/api';
import { BigMath } from '~/utils/numbers';

import { EntityAvatar } from '../ui/avatar';
import { CurrencyInput } from '../ui/currency-input';
import { AppDrawer } from '../ui/drawer';
import { Label } from '../ui/label';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group';
import { type Party, partyName, settlementParts } from './parties';

const JOINT = 'joint';

/** Who in a household paid or was paid: one member, or the joint account (everyone equally). */
const MemberChoice: React.FC<{
  party: Party;
  label: string;
  value: string;
  onChange: (value: string) => void;
}> = ({ party, label, value, onChange }) => {
  const { t, displayName } = useTranslationWithUtils();
  return (
    <div className="w-full max-w-xs">
      <p className="mb-2 text-sm font-semibold">{label}</p>
      <RadioGroup value={value} onValueChange={onChange}>
        {party.members.map((member) => (
          <Label key={member.id} className="flex cursor-pointer items-center gap-3 py-1">
            <RadioGroupItem value={String(member.id)} />
            <EntityAvatar entity={member} size={20} />
            {displayName(member)}
          </Label>
        ))}
        <Label className="flex cursor-pointer items-center gap-3 py-1">
          <RadioGroupItem value={JOINT} />
          {t('joint_finances.joint_account')}
        </Label>
      </RadioGroup>
    </div>
  );
};

const defaultChoice = (party: Party, meId: number | undefined) =>
  party.members.some((member) => member.id === meId) ? String(meId) : JOINT;

const chosen = (party: Party, choice: string): User[] =>
  JOINT === choice ? party.members : party.members.filter((member) => String(member.id) === choice);

/**
 * Alex hack: settle up between parties in a group with joint finances. A payment to or from a
 * household is recorded against the member chosen, or split equally across all members (a joint
 * account), as ordinary two-person settlements.
 */
export const JointSettleUp: React.FC<{
  amount: bigint;
  currency: string;
  payer: Party;
  receiver: Party;
  groupId: number;
  children: ReactNode;
}> = ({ amount: initialAmount, currency, payer, receiver, groupId, children }) => {
  const { data } = useSession();
  const meId = data?.user.id;
  const { displayName, t, getCurrencyHelpersCached } = useTranslationWithUtils();
  const [amount, setAmount] = useState<bigint>(BigMath.abs(initialAmount));
  const [amountStr, setAmountStr] = useState(
    getCurrencyHelpersCached(currency).toUIString(BigMath.abs(initialAmount)),
  );
  const [payerChoice, setPayerChoice] = useState(defaultChoice(payer, meId));
  const [receiverChoice, setReceiverChoice] = useState(defaultChoice(receiver, meId));

  const addExpenseMutation = api.expense.addOrEditExpense.useMutation();
  const utils = api.useUtils();

  const you = t('actors.you');
  const parts = settlementParts(
    amount,
    payer.household ? chosen(payer, payerChoice) : payer.members,
    receiver.household ? chosen(receiver, receiverChoice) : receiver.members,
  );

  const onValueChange = ({
    strValue,
    bigIntValue,
  }: {
    strValue?: string;
    bigIntValue?: bigint;
  }) => {
    if (strValue !== undefined) {
      setAmountStr(strValue);
    }
    if (bigIntValue !== undefined) {
      setAmount(bigIntValue);
    }
  };

  const save = () => {
    if (0 === parts.length) {
      return;
    }
    addExpenseMutation.mutate(
      parts.map((part) => ({
        name: t('ui.settle_up_name'),
        currency,
        amount: part.amount,
        splitType: SplitType.SETTLEMENT,
        groupId,
        participants: [
          { userId: part.payer.id, amount: part.amount },
          { userId: part.receiver.id, amount: -part.amount },
        ],
        paidBy: part.payer.id,
        category: DEFAULT_CATEGORY,
      })),
      {
        onSuccess: () => {
          utils.group.invalidate().catch(console.error);
        },
        onError: (error) => {
          console.error('Error while saving settlement:', error);
          toast.error(t('errors.saving_expense'));
        },
      },
    );
  };

  return (
    <AppDrawer
      trigger={children}
      leftAction={t('actions.back')}
      title={t('ui.settlement')}
      actionTitle={t('actions.save')}
      actionOnClick={save}
      actionDisabled={0 === parts.length}
      className="h-[80vh]"
      shouldCloseOnAction
    >
      <div className="mt-6 flex flex-col items-center gap-6 px-4">
        <div className="flex flex-col items-center">
          <div className="flex items-center gap-5">
            <EntityAvatar entity={payer.members[0]} />
            <ArrowRightIcon className="h-6 w-6 text-gray-600" />
            <EntityAvatar entity={receiver.members[0]} />
          </div>
          <p className="mt-2 text-center text-sm text-gray-400">
            {t('joint_finances.pays', {
              payer: partyName(payer, displayName, meId, you),
              plural: payer.household || payer.members[0]?.id === meId ? 'yes' : 'no',
              receiver: partyName(receiver, displayName, meId, you).replace(you, you.toLowerCase()),
              amount: getCurrencyHelpersCached(currency).toUIString(amount),
            })}
          </p>
        </div>
        <CurrencyInput
          currency={currency}
          strValue={amountStr}
          className="mx-auto w-[150px] text-center text-lg"
          onValueChange={onValueChange}
        />
        {payer.household ? (
          <MemberChoice
            party={payer}
            label={t('joint_finances.paid_by')}
            value={payerChoice}
            onChange={setPayerChoice}
          />
        ) : null}
        {receiver.household ? (
          <MemberChoice
            party={receiver}
            label={t('joint_finances.paid_to')}
            value={receiverChoice}
            onChange={setReceiverChoice}
          />
        ) : null}
        {1 < parts.length ? (
          <p className="text-center text-xs text-gray-500">
            {t('joint_finances.joint_split_note', { count: parts.length })}
          </p>
        ) : null}
      </div>
    </AppDrawer>
  );
};
