import { useCallback, useState } from 'react';

const newId = () =>
  'undefined' !== typeof crypto && 'function' === typeof crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * Alex hack: one request id per user action. It stays the same across retries and repeated taps
 * (so the server applies the action once) and is renewed after the action succeeds.
 */
export const useRequestId = () => {
  const [requestId, setRequestId] = useState(newId);
  const renew = useCallback(() => setRequestId(newId()), []);
  return [requestId, renew] as const;
};
