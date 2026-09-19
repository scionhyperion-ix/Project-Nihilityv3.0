# Project Nihility v3.0

Nihility is an independent, storage-backed system workspace.

## Core rule

PluralKit and Tupperbox are optional integrations, not the source of truth.

When data is imported into Nihility, the copied member belongs to Nihility. Later edits stay in Nihility unless an explicit sync feature says otherwise.

The only automatic outbound sync currently implemented is Share fronting updates for PluralKit.

## Account safety

The instance is invite-only.

There is no "first signup wins" owner behavior anymore.

The owner email is stored only in the private database configuration. Until an owner email is explicitly configured, all new account creation is rejected.

Once configured:
- that email may create the owner account
- other accounts require an owner-created invite
- browser clients cannot change account email, user ID, or role
- members cannot promote themselves to owner
- profile editing is limited to display name and avatar fields

Supabase Row Level Security still isolates each account's members, fronts, integrations, and media.

## Front sharing

PluralKit is optional.

When a front changes:

1. Nihility records the front in its own database.
2. If PluralKit is connected on that device and Share fronting updates is enabled, Nihility mirrors the front to PK.
3. If a selected member has no PluralKit ID, the local front still succeeds and PK sharing is skipped instead of silently sending a partial front.

The PluralKit token stays in the browser. It is not stored in the Nihility database.

Disconnecting PK on a device disables automatic front sharing until reconnected.

## Imports

PluralKit imports are copy-in only.

Re-importing does not overwrite existing Nihility-owned member records. Existing linked PK members are skipped and only previously unseen PK members are added.

## Member archival

Removing a member from active use archives the record instead of deleting it.

Archived members:
- disappear from active member lists and front pickers
- remain available to historical front records
- keep their historical identity and media references intact

## Front chronology

Front logging rejects:
- unavailable or archived members
- start times in the future
- a start time earlier than the currently active front

This prevents impossible histories where an active front ends before it began.

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

- `001_initial.sql`: base data model
- `002_supabase_media_storage.sql`: media storage
- `003_optimize_rls_and_foreign_keys.sql`: indexes and RLS performance
- `004_accounts_integrations_and_fronts.sql`: profiles, invites, integration settings, and local front logging
- `005_harden_account_bootstrap.sql`: private auth bootstrap triggers
- `006_require_nihility_profile.sql`: profile-gated data and media access
- `007_security_integrity_hardening.sql`: explicit owner allowlist, immutable account roles, archival, invite refresh, and front chronology checks

## Deployment

GitHub Pages must be enabled once in repository Settings before the Pages workflow can deploy. The GitHub App token cannot perform this one-time repository setting change.
