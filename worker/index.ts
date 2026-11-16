import { defaultCache } from '@serwist/turbopack/worker';
import {
  ExpirationPlugin,
  NetworkFirst,
  type PrecacheEntry,
  type RuntimeCaching,
  Serwist,
  type SerwistGlobalConfig,
  type SerwistPlugin,
} from 'serwist';

import { getNotificationUrl, parsePushMessageJson } from '~/types/notifications';

// This declares the value of `injectionPoint` to TypeScript.
// `injectionPoint` is the string that will be replaced by the
// Actual precache manifest. By default, this string is set to
// `"self.__SW_MANIFEST"`.
declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

/*
 * Alex hack: behave better on patchy or no signal. Pages, page data and API reads fall back to
 * the cache after a few seconds instead of waiting for the network to give up (the network
 * response still refreshes the cache when it arrives), and a page never opened before shows an
 * offline page instead of the browser's error.
 */
const NETWORK_TIMEOUT_SECONDS = 3;
const OFFLINE_PAGE = '/en/offline';

/** The add page doesn't depend on its query (?groupId=…), so one cached copy serves them all. */
const ignoreAddQuery: SerwistPlugin = {
  cacheKeyWillBeUsed: async ({ request }) => {
    const url = new URL(request.url);
    if (/\/add(\.json)?$/.test(url.pathname)) {
      url.search = '';
      return url.href;
    }
    return request;
  },
};

const patchySignalCaching: RuntimeCaching[] = [
  {
    // The signed-in session, so pages opened offline don't think you've signed out.
    matcher: ({ sameOrigin, url: { pathname } }) => sameOrigin && '/api/auth/session' === pathname,
    method: 'GET',
    handler: new NetworkFirst({
      cacheName: 'auth-session',
      networkTimeoutSeconds: NETWORK_TIMEOUT_SECONDS,
      plugins: [new ExpirationPlugin({ maxEntries: 1 })],
    }),
  },
  {
    matcher: ({ request, sameOrigin, url: { pathname } }) =>
      sameOrigin && 'navigate' === request.mode && !pathname.startsWith('/api/'),
    handler: new NetworkFirst({
      cacheName: 'pages',
      networkTimeoutSeconds: NETWORK_TIMEOUT_SECONDS,
      plugins: [ignoreAddQuery, new ExpirationPlugin({ maxEntries: 64 })],
    }),
  },
  {
    matcher: ({ sameOrigin, url: { pathname } }) =>
      sameOrigin && /^\/_next\/data\/.+\/.+\.json$/.test(pathname),
    handler: new NetworkFirst({
      cacheName: 'next-data',
      networkTimeoutSeconds: NETWORK_TIMEOUT_SECONDS,
      plugins: [ignoreAddQuery, new ExpirationPlugin({ maxEntries: 64 })],
    }),
  },
  {
    matcher: ({ sameOrigin, url: { pathname } }) => sameOrigin && pathname.startsWith('/api/trpc/'),
    method: 'GET',
    handler: new NetworkFirst({
      cacheName: 'apis',
      networkTimeoutSeconds: NETWORK_TIMEOUT_SECONDS,
      plugins: [new ExpirationPlugin({ maxEntries: 128, maxAgeSeconds: 7 * 24 * 60 * 60 })],
    }),
  },
];

const serwist = new Serwist({
  // oxlint-disable-next-line no-underscore-dangle -- Serwist replaces this declared manifest field during its build step.
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [...patchySignalCaching, ...defaultCache],
  fallbacks: {
    entries: [{ url: OFFLINE_PAGE, matcher: ({ request }) => 'document' === request.destination }],
  },
});

// Alex hack: on sign-out, forget the cached session and everything cached for that user.
const USER_CACHES = ['auth-session', 'pages', 'next-data', 'apis', 'others'];
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if ('POST' === event.request.method && '/api/auth/signout' === url.pathname) {
    event.waitUntil(Promise.all(USER_CACHES.map((name) => caches.delete(name))));
  }
});

self.addEventListener('push', (event) => {
  const result = parsePushMessageJson(event?.data?.text() ?? '{}');
  if (!result?.success) {
    console.warn('Ignoring invalid push notification payload');
    return;
  }

  const { title, message, data } = result.data;
  event.waitUntil(
    self.registration.showNotification(title, {
      body: message,
      icon: '/icons/android-chrome-192x192.png',
      data,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window' });

      const url = getNotificationUrl(event.notification.data);

      const matchingClient = clientList.find((client) => client.focused) ?? clientList[0];

      if (matchingClient) {
        const client = await matchingClient.focus();
        await client.navigate(url);
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});

serwist.addEventListeners();
