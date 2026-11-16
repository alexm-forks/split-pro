/**
 * This is the client-side entrypoint for your tRPC API. It is used to create the `api` object which
 * contains the Next.js App-wrapper, as well as your type-safe React Query hooks.
 *
 * We also create a few inference helpers for input and output types.
 */
import { QueryClient, onlineManager } from '@tanstack/react-query';
import { httpBatchLink, loggerLink } from '@trpc/client';
import { createTRPCNext } from '@trpc/next';
import { type inferRouterInputs, type inferRouterOutputs } from '@trpc/server';
import superjson from 'superjson';

import { type AppRouter } from '~/server/api/root';
import { TIME_ZONE_HEADER } from '~/utils/timeZone';

export const getBaseUrl = () => {
  if ('undefined' !== typeof window) {
    return '';
  } // Browser should use relative url
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  } // SSR should use vercel url
  return `http://localhost:${process.env.PORT ?? 3000}`; // Dev SSR should use localhost
};

/**
 * Links used to determine request flow from client to server.
 *
 * @see https://trpc.io/docs/links
 */
const links = () => [
  loggerLink<AppRouter>({
    enabled: (opts) =>
      'development' === process.env.NODE_ENV ||
      ('down' === opts.direction && opts.result instanceof Error),
  }),
  httpBatchLink<AppRouter>({
    url: `${getBaseUrl()}/api/trpc`,
    transformer: superjson,
    headers: () =>
      'undefined' === typeof window
        ? {}
        : { [TIME_ZONE_HEADER]: Intl.DateTimeFormat().resolvedOptions().timeZone },
  }),
];

/** No response at all (offline, dropped connection), as opposed to an error from the server. */
export const isNetworkError = (error: unknown) =>
  error instanceof Error &&
  ('TypeError' === error.cause?.constructor.name ||
    /failed to fetch|networkerror|load failed|network request failed/i.test(error.message));

/**
 * Alex hack: one query client in the browser, configured for patchy signal. Queries try the
 * network even when the device says it's offline (the service worker answers from its cache),
 * and writes retry when there was no response at all, which is safe because they carry request
 * ids (the server applies each once). See src/components/Offline for the offline queue.
 */
const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { networkMode: 'offlineFirst' },
      mutations: {
        retry: (failureCount, error) => isNetworkError(error) && 3 > failureCount,
      },
    },
  });

let browserQueryClient: QueryClient | undefined = undefined;
export const getQueryClient = () => {
  if ('undefined' === typeof window) {
    return createQueryClient();
  }
  if (!browserQueryClient) {
    // React Query assumes it starts online; opened with no signal, it should know it isn't.
    onlineManager.setOnline(navigator.onLine);
    browserQueryClient = createQueryClient();
  }
  return browserQueryClient;
};

/** A set of type-safe react-query hooks for your tRPC API. */
export const api = createTRPCNext<AppRouter>({
  config() {
    return {
      links: links(),
      queryClient: getQueryClient(),
    };
  },
  /**
   * Whether tRPC should await queries when server rendering pages.
   *
   * @see https://trpc.io/docs/nextjs#ssr-boolean-default-false
   */
  ssr: false,
  transformer: superjson,
});

/**
 * Inference helper for inputs.
 *
 * @example type HelloInput = RouterInputs['example']['hello']
 */
export type RouterInputs = inferRouterInputs<AppRouter>;

/**
 * Inference helper for outputs.
 *
 * @example type HelloOutput = RouterOutputs['example']['hello']
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>;
