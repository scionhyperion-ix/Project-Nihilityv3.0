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

## Backup and restore

The owner can create portable Nihility backups from Settings.

- JSON backups contain members, groups, group memberships, front history, app settings, import history, and safe profile fields.
- ZIP backups contain the same data plus private media when those files can be read.
- Restore always validates and previews the backup before replacement.
- Restore is atomic at the database layer and remaps internal IDs to prevent cross-account ownership problems.
- Passwords, auth sessions, invitations, integration credentials, and raw security-event logs are never included.
- Full backup and restore actions are owner-only, rate-limited, and audited.

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

## System timeline

Nihility has a database-backed chronological system timeline.

- Timeline events are written by database triggers for front logs, member create/archive/restore, group creation and membership changes, relationship changes, and import records.
- Successful PluralKit two-way syncs add one safe summary event with counts only.
- Successful backup replacement adds a restore event.
- Browser accounts can read their own timeline through RLS but cannot directly insert, update, or delete timeline rows.
- Timeline metadata deliberately excludes front notes, private notes, mood, context, activity, location, passwords, sessions, integration tokens, and raw security-event logs.
- Permanent deletion cascades timeline rows that reference the deleted member/group/front, avoiding sensitive historical ghosts for erased records.
- The initial migration backfills only history with trustworthy timestamps from existing data.
- Timeline-aware backups preserve events with member/group/front ID remapping. Older backups reconstruct only exactly derivable historical events and then record the restore.
- The UI loads timeline events in bounded pages and supports category, member, range, and text filtering.

## Member relationships and graph

Nihility supports first-class connections between members.

- Each connection references two real Nihility members rather than storing names as text.
- Relationship labels are directional, so one record can represent pairs such as `Parent` / `Child` or symmetric labels such as `Sibling` / `Sibling`.
- Reversed duplicate pairs and self-connections are rejected at the database layer.
- Composite ownership foreign keys prevent cross-account member relationships.
- Existing connections to archived members remain visible and editable; the UI blocks creating new connections to archived members.
- Member profiles show a connections section with direct navigation to linked profiles.
- The optional graph view renders direct connections locally in the browser and does not send relationship data to an external graph service.
- The graph is bounded to 40 rendered neighbors for device safety while the profile list remains complete.
- Connections are included in backup export, validation, preview counts, and replacement restore with member-ID remapping.
- Deleting a member permanently cascades its relationships; archiving does not remove them.

## Member custom fields and tags

Nihility members can use owner-defined structured fields and reusable searchable tags.

- Supported field types: text, long text, number, yes/no, date, select, and multi-select.
- Field definitions use stable UUIDs plus short search keys such as `source`, `role`, or `species`.
- Member search supports plain terms plus qualified filters such as `tag:frequent`, `source:RE`, `role:doctor`, and quoted values.
- Search parsing happens locally in the browser; user filter text is never interpolated into SQL or PostgREST filters.
- Field definitions and tags are owner-managed, while authorized accounts can assign configured values and tags to their own members.
- Composite ownership foreign keys prevent cross-account field/tag assignment.
- Database triggers enforce field types, configured select options, per-account quotas, per-member tag quotas, and safe field-definition changes.
- Custom metadata is included in Nihility backups with ID remapping on restore. Older v1 backups without these sections remain compatible.
- Deleting a field or tag cascades only its member values/assignments; members themselves are never deleted.

## Front notes and per-fronter details

Fronts can optionally store an overall note plus per-fronter details such as mood, context, activity, location, a fronter note, and a private note.

- Every field is optional and length-limited in both the UI and database.
- Per-fronter details stay attached to that member's front-membership row.
- Private notes and locations are hidden from compact Home and History views.
- No front notes or per-fronter detail fields are sent to PluralKit.
- Private notes and locations are still part of Nihility account data and are included in backups.
- New detailed fronts close the prior front's open per-fronter timing rows when the front changes.
- History corrections preserve and validate these fields with the same revision protection as timing edits.
- Old v1 Nihility backups remain restorable; missing detail fields restore as null.

