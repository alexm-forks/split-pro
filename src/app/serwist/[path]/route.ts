import { createSerwistRoute } from '@serwist/turbopack';

// Next.js requires route configuration values to be statically analyzable.
export const dynamic = 'force-static';
export const dynamicParams = false;
export const revalidate = false;

// Alex hack: precache the offline fallback page; the revision changes with every build.
const BUILD_REVISION = Date.now().toString(36);

export const { generateStaticParams, GET } = createSerwistRoute({
  swSrc: 'worker/index.ts',
  useNativeEsbuild: true,
  additionalPrecacheEntries: [{ url: '/en/offline', revision: BUILD_REVISION }],
});
