import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { type Mutation, type QueryClient, dehydrate, onlineManager } from '@tanstack/react-query';
import { persistQueryClient } from '@tanstack/react-query-persist-client';
import { toast } from 'sonner';
import { parse, stringify } from 'superjson';

/**
 * Alex hack: the offline queue. The query cache and any queued (paused) adds or settle-ups are
 * saved on the device per user, so pages show their last-known data offline and queued
 * changes are sent once there's signal again, even after the app was closed. Each queued change
 * carries a request id, so the server applies it exactly once however often it's retried.
 */
const STORAGE_PREFIX = 'splitpro-offline:';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return undefined; // Storage blocked (e.g. some private modes): no persistence.
  }
};

/** Only new expenses and settle-ups queue; edits need signal (someone else may change it). */
export const isQueueable = (mutation: Mutation) => {
  const key = JSON.stringify(mutation.options.mutationKey ?? []);
  const { variables } = mutation.state;
  const items: unknown[] = Array.isArray(variables) ? variables : [variables];
  return (
    key.includes('"addOrEditExpense"') &&
    items.every(
      (item) =>
        'object' === typeof item && null !== item && !('expenseId' in item && item.expenseId),
    )
  );
};

const dehydrateOptions = {
  shouldDehydrateQuery: (query: { state: { status: string } }) => 'success' === query.state.status,
  shouldDehydrateMutation: (mutation: Mutation) => mutation.state.isPaused && isQueueable(mutation),
};

/* Set while signed in, so a change can be written to the device the moment it's queued. */
let saveNow: (() => void) | undefined = undefined;

/** Write the cache and queue to the device now, not after the usual throttle. */
export const saveOfflineNow = () => saveNow?.();

export const persistOffline = (queryClient: QueryClient, userId: number) => {
  const store = storage();
  if (!store) {
    return () => undefined;
  }
  const key = `${STORAGE_PREFIX}${userId}`;
  const persister = createAsyncStoragePersister({
    storage: store,
    key,
    serialize: (client) => stringify(client),
    deserialize: (value) => parse(value),
    throttleTime: 1000,
  });
  const [unsubscribe, restored] = persistQueryClient({
    queryClient,
    persister,
    maxAge: MAX_AGE_MS,
    dehydrateOptions,
  });
  /* The throttled save can be lost if the app is closed straight after queueing, so a queued
     change, and the app being hidden or closed, saves straight away. */
  saveNow = () => {
    try {
      store.setItem(
        key,
        stringify({
          buster: '',
          timestamp: Date.now(),
          clientState: dehydrate(queryClient, dehydrateOptions),
        }),
      );
    } catch (error) {
      console.error('Failed to save offline data', error);
    }
  };
  const saveIfHidden = () => {
    if ('hidden' === document.visibilityState) {
      saveOfflineNow();
    }
  };
  document.addEventListener('visibilitychange', saveIfHidden);
  window.addEventListener('pagehide', saveOfflineNow);
  restored
    .then(() => (onlineManager.isOnline() ? queryClient.resumePausedMutations() : undefined))
    .catch((error: unknown) => console.error('Failed to restore offline data', error));
  return () => {
    unsubscribe();
    document.removeEventListener('visibilitychange', saveIfHidden);
    window.removeEventListener('pagehide', saveOfflineNow);
    saveNow = undefined;
  };
};

/** After sending a change: if it was queued instead (offline), say so. */
export const noticeIfQueued = (message: string) => {
  if (!onlineManager.isOnline()) {
    saveOfflineNow();
    toast.success(message);
  }
};

/** On sign-out: forget every user's saved data and queue on this device. */
export const clearOfflineData = (queryClient: QueryClient) => {
  queryClient.clear();
  const store = storage();
  if (!store) {
    return;
  }
  Object.keys(store)
    .filter((key) => key.startsWith(STORAGE_PREFIX))
    .forEach((key) => store.removeItem(key));
};
