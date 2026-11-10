# SCIM provisioning from Pocket ID

A minimal SCIM 2.0 endpoint, so [Pocket ID](https://github.com/pocket-id/pocket-id) (v2.0+) can
create and update Split Pro users. People can then be added to expenses before they ever log in,
and their first Pocket ID login lands on that account.

## Set up

1. On the Split Pro server, set a token and restart:

   ```
   SCIM_TOKEN=<long random secret>
   ```

   (e.g. `openssl rand -base64 32`). Without it, `/api/scim/v2` returns `404`.

2. In Pocket ID: **Administration → OIDC Clients → Split Pro → SCIM Provisioning**:
   - **SCIM Endpoint:** `https://<your-splitpro-host>/api/scim/v2`
   - **SCIM Token:** the same secret.

   Enable it and use **Sync now** to check. Pocket ID then syncs hourly and a few minutes after
   changes. The OIDC client's allowed groups decide who is provisioned.

3. Optional: `INVITE_ONLY=true` so accounts only come from Pocket ID (and people you add).

## What it does

- **New Pocket ID user:**
  - If a Split Pro user already has that email (for example someone added to an expense by
    email), that user is linked and takes Pocket ID's name.
  - Otherwise a new user is created.
  - The link is a normal login `Account` row (Pocket ID's user id is its OIDC `sub`), so no
    database changes are involved.
- **Changed Pocket ID user:** name and email are updated. Pocket ID is the source of truth for
  names. An email that another Split Pro user already has is left unchanged, with a warning in
  the logs.
- **Disabled, deleted or no-longer-allowed users are ignored**, along with their history.
  Remove access in Pocket ID.
- **Groups** are accepted so Pocket ID's sync succeeds, but not stored: Pocket ID groups aren't
  Split Pro groups.

**Treat `SCIM_TOKEN` like an admin password:** whoever holds it can link a Pocket ID login to
any existing account with a matching email. An account already linked to a different Pocket ID
user is never linked again.

The endpoint only lists users linked to the OIDC login (`OIDC_NAME`), so other accounts are never
touched. Code: `src/server/scim.ts`, `src/pages/api/scim/v2/[...path].ts`.
