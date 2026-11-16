import { WifiOff } from 'lucide-react';
import Head from 'next/head';
import { useTranslation } from 'next-i18next';

import { Button } from '~/components/ui/button';
import { withI18nStaticProps } from '~/utils/i18n/server';

/**
 * Alex hack: shown by the service worker when a page can't load and was never cached (precached
 * at /en/offline). Pages you've opened before still load offline.
 */
const OfflinePage = () => {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('offline.title')}</title>
      </Head>
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <WifiOff className="size-10 text-gray-400" />
        <h1 className="text-xl font-semibold">{t('offline.title')}</h1>
        <p className="max-w-sm text-sm text-gray-400">{t('offline.description')}</p>
        <div className="flex gap-2">
          <Button onClick={() => window.location.reload()}>{t('offline.retry')}</Button>
          <Button variant="secondary" onClick={() => window.location.assign('/')}>
            {t('offline.home')}
          </Button>
        </div>
      </main>
    </>
  );
};

export const getStaticProps = withI18nStaticProps(['common']);

export default OfflinePage;
