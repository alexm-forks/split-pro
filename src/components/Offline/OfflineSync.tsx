import { onlineManager, useMutationState, useQueryClient } from '@tanstack/react-query';
import { CloudOff, RefreshCw } from 'lucide-react';
import { useTranslation } from 'next-i18next';
import React, { useEffect, useSyncExternalStore } from 'react';

import { api } from '~/utils/api';

import { persistOffline } from './offlineQueue';

const useOnline = () =>
  useSyncExternalStore(
    (onChange) => onlineManager.subscribe(onChange),
    () => onlineManager.isOnline(),
    () => true,
  );

/**
 * Alex hack: mounted once while signed in. Lets queued adds and settle-ups resume after the app
 * reloads, saves the cache and queue on the device for this user, and shows when you're offline
 * or have changes waiting to be sent.
 */
export const OfflineSync: React.FC<{ userId: number }> = ({ userId }) => {
  const { t } = useTranslation();
  const utils = api.useUtils();
  const queryClient = useQueryClient();
  const online = useOnline();
  const queued = useMutationState({
    filters: { status: 'pending' },
    select: (mutation) => mutation.state.isPaused,
  }).filter(Boolean).length;

  useEffect(() => {
    /* A queued change restored after a reload has no component to run it: these defaults do,
       then refresh everything so the new expense shows up. */
    utils.expense.addOrEditExpense.setMutationDefaults(({ canonicalMutationFn }) => ({
      mutationFn: canonicalMutationFn,
      onSuccess: () => queryClient.invalidateQueries(),
    }));
    return persistOffline(queryClient, userId);
  }, [queryClient, userId, utils]);

  if (online && 0 === queued) {
    return null;
  }
  return (
    /* Taps pass through, so it never blocks the buttons underneath. */
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4"
    >
      <div className="bg-background/95 flex items-center gap-2 rounded-full border px-3 py-1 text-xs text-gray-400 shadow">
        {online ? <RefreshCw className="size-3 animate-spin" /> : <CloudOff className="size-3" />}
        <span>
          {online
            ? t('offline.sending', { count: queued })
            : t('offline.banner', { count: queued })}
        </span>
      </div>
    </div>
  );
};
