# Project Nihility v3.0

Nihility is an independent, storage-backed system workspace.

## Core rule

PluralKit and Tupperbox are optional integrations, not the source of truth.

When data is imported into Nihility, the copied member belongs to Nihility. Later edits stay in Nihility unless an explicit sync feature says otherwise.

The only automatic outbound sync currently implemented is Share fronting updates for PluralKit.

## Front sharing

The PluralKit setting defaults to enabled when a connection is first created.

When a front changes:

1. Nihility records the front in its own database.
2. If PluralKit is connected on that device and Share fronting updates is enabled, Nihility mirrors the front to PK.
3. If a selected member has no PluralKit ID, the local front still succeeds and PK sharing is skipped instead of silently sending a partial front.

The PluralKit token stays in the browser. It is not stored in the Nihility database.

## Accounts

The first authenticated account to open the configured Nihility instance becomes the owner.

Later accounts require an email invite created from the Profile page.

Each account currently has isolated members, groups, fronts, media, and integration settings.

## Storage

Supabase stores structured data and optional uploaded media.

- avatars: 2 MB maximum
- banners: 5 MB maximum
- profile avatars: 2 MB maximum
- PNG, JPEG, WebP, GIF

External image links remain supported and consume no Supabase object storage.

## UI

The main application intentionally follows the Rainbow layout and interaction style. The main new surface is the account Profile page, which contains identity, account role, avatar, invites, and sign-out controls.

## Migrations

- 001_initial.sql: base data model
- 002_supabase_media_storage.sql: media storage
- 003_optimize_rls_and_foreign_keys.sql: indexes and RLS performance
- 004_accounts_integrations_and_fronts.sql: profiles, invites, integration settings, and local front logging
