import { env } from '~/env';

/** NextAuth's provider id for the generic OIDC login, also the `Account.provider` of its users. */
export const oidcProviderId = () => env.OIDC_NAME?.toLowerCase() ?? 'oidc';
