import type { User } from '@prisma/client';
import { HeartHandshake, Pencil, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import { toast } from 'sonner';

import { useTranslationWithUtils } from '~/hooks/useTranslationWithUtils';
import { type Households } from '~/lib/jointFinances';
import { api } from '~/utils/api';

import { EntityAvatar } from '../ui/avatar';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { AppDrawer } from '../ui/drawer';
import { Label } from '../ui/label';
import { buildParties, partyName } from './parties';

/** Pick the members of one household (people already in another household aren't offered). */
const HouseholdEditor: React.FC<{
  users: User[];
  taken: Set<number>;
  initial: number[];
  title: string;
  onSave: (members: number[]) => void;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ users, taken, initial, title, onSave, disabled, children }) => {
  const { t, displayName } = useTranslationWithUtils();
  const [selected, setSelected] = useState<number[]>(initial);

  return (
    <AppDrawer
      trigger={children}
      disableTrigger={disabled}
      onTriggerClick={() => setSelected(initial)}
      title={title}
      leftAction={t('actions.cancel')}
      actionTitle={t('actions.save')}
      actionDisabled={2 > selected.length}
      actionOnClick={() => onSave(selected)}
      shouldCloseOnAction
    >
      <p className="mt-4 text-sm text-gray-500">{t('joint_finances.choose_members')}</p>
      <div className="mt-4 flex flex-col gap-3">
        {users
          .filter((user) => !taken.has(user.id))
          .map((user) => (
            <Label key={user.id} className="flex cursor-pointer items-center gap-3">
              <Checkbox
                checked={selected.includes(user.id)}
                onCheckedChange={(checked) =>
                  setSelected((current) =>
                    checked ? [...current, user.id] : current.filter((id) => id !== user.id),
                  )
                }
              />
              <EntityAvatar entity={user} size={24} />
              {displayName(user)}
            </Label>
          ))}
      </div>
    </AppDrawer>
  );
};

/**
 * Alex hack: group setting for joint finances: households whose members never owe each other
 * and settle up together. Only applies while the group simplifies debts.
 */
export const JointFinancesSettings: React.FC<{
  groupId: number;
  users: User[];
  households: Households;
  simplifyDebts: boolean;
  disabled?: boolean;
  onChanged: () => void;
}> = ({ groupId, users, households, simplifyDebts, disabled, onChanged }) => {
  const { t, displayName } = useTranslationWithUtils();
  const meId = api.user.me.useQuery().data?.id;
  const mutation = api.group.setJointFinances.useMutation();
  const parties = buildParties(users, households).filter((party) => party.household);

  const save = (next: Households) => {
    mutation.mutate(
      { groupId, households: next },
      {
        onSuccess: () => {
          toast.success(t('joint_finances.updated'));
          onChanged();
        },
        onError: (error) => toast.error(error.message),
      },
    );
  };

  const takenExcept = (index?: number) => new Set(households.filter((_, i) => i !== index).flat());

  return (
    <div className="mt-6">
      <p className="flex items-center font-semibold">
        <HeartHandshake className="mr-2 size-4" />
        {t('joint_finances.title')}
      </p>
      <p className="mt-1 text-sm text-gray-500">
        {t('joint_finances.description')}{' '}
        {simplifyDebts ? null : (
          <span className="text-orange-600">{t('joint_finances.needs_simplify')}</span>
        )}
      </p>
      <div className="mt-2 flex flex-col gap-2">
        {0 === parties.length ? (
          <p className="text-sm text-gray-500">{t('joint_finances.none')}</p>
        ) : null}
        {parties.map((party, index) => (
          <div key={party.id} className="flex items-center justify-between gap-2">
            <span className="truncate text-sm">
              {partyName(party, displayName, meId, t('actors.you'))}
            </span>
            <div className="flex shrink-0 gap-1">
              <HouseholdEditor
                users={users}
                taken={takenExcept(index)}
                initial={households[index] ?? []}
                title={t('joint_finances.edit_household')}
                disabled={disabled || mutation.isPending}
                onSave={(members) =>
                  save(households.map((household, i) => (i === index ? members : household)))
                }
              >
                <Button size="icon" variant="ghost" className="size-8" disabled={disabled}>
                  <Pencil className="size-4" />
                </Button>
              </HouseholdEditor>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                aria-label={t('joint_finances.remove_household')}
                disabled={disabled || mutation.isPending}
                onClick={() => save(households.filter((_, i) => i !== index))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>
        ))}
        <HouseholdEditor
          users={users}
          taken={takenExcept()}
          initial={[]}
          title={t('joint_finances.add_household')}
          disabled={disabled || mutation.isPending || 2 > users.length - takenExcept().size}
          onSave={(members) => save([...households, members])}
        >
          <Button
            size="sm"
            variant="secondary"
            className="w-fit"
            disabled={disabled || 2 > users.length - takenExcept().size}
          >
            {t('joint_finances.add_household')}
          </Button>
        </HouseholdEditor>
      </div>
    </div>
  );
};
