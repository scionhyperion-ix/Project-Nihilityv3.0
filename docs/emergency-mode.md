# Nihility Emergency Mode

Emergency Mode keeps Project Nihility usable during temporary Supabase or network outages without creating a second writable source of truth.

## Current behavior

- A Service Worker caches the same-origin app shell after a successful visit.
- A per-account IndexedDB snapshot stores the last synchronized Nihility dataset.
- Snapshots are encrypted with a non-extractable AES-256-GCM CryptoKey stored by the browser.
- PluralKit tokens, integration secrets, account passwords, session tokens, recovery secrets, and decrypted journal entries are never written to the Emergency Mode snapshot.
- Front changes made while Emergency Mode is active are queued locally, applied optimistically to the UI, and replayed in order after Supabase recovers.
- Queued front payloads are encrypted with the same per-account local cache key.
- Media uploads, PluralKit mutations, journal mutations, and destructive server actions remain online-only.
- Explicit sign-out deletes that account's Emergency Mode snapshot, queue, and local cache key.

## Entering Emergency Mode

Emergency Mode starts when:

1. the browser reports that it is offline, or
2. repeated network/5xx Supabase failures occur within a short period, or
3. startup cannot reach Supabase but a valid cached session identity and an Emergency Mode snapshot are available.

A persistent notification shows that cached data is being used, the age of the snapshot, and how many front changes are queued.

## Recovery

While Emergency Mode is active, normal background polling is paused. Nihility periodically performs a bounded recovery probe and also retries when the browser comes online.

Recovery order:

1. verify the authenticated Supabase profile endpoint responds;
2. replay encrypted queued front operations in original order;
3. refresh Nihility from Supabase;
4. replace the local snapshot;
5. leave Emergency Mode.

If replay fails, the remaining queue is retained and Emergency Mode stays active.

## Security boundaries

Emergency Mode is not an alternate authentication system. It only uses an existing unexpired browser session identity. If Nihility cannot verify an account and there is no matching per-account emergency snapshot, the app does not expose cached system data.

The local cache is intentionally limited to application data that is already visible after sign-in. The encrypted journal remains outside the snapshot, and decrypted journal text is never cached by Emergency Mode.

## Planned resilience layers

The intended next stages are:

1. private off-provider encrypted account snapshots, for example Cloudflare R2 behind a Worker;
2. private media backup outside Supabase;
3. an independent health endpoint to distinguish a Supabase outage from the user's own connection;
4. compare-first recovery between a remote emergency snapshot and the recovered Supabase state;
5. optional warm Postgres/Supabase-compatible disaster recovery for long outages.

The off-provider layers must remain read-mostly during ordinary outages. Supabase remains the primary writable source of truth so Nihility does not create two independently diverging databases.
