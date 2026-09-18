# Project Nihility v3.0

Private, storage-backed personal system workspace.

## Storage model

### Supabase
Stores authentication and structured data:
- members
- groups
- front history
- notes and metadata
- PluralKit and Tupperbox IDs
- external avatar and banner URLs
- settings and import history

Supabase Storage is not required.

### Cloudflare R2
Used only for files uploaded directly through Nihility.

Current limits:
- avatar: 2 MB
- banner: 5 MB
- PNG, JPEG, WebP, GIF

If an external image URL is used, Nihility stores only the URL in Supabase.

## Setup

1. Create a Supabase project.
2. Run `supabase/migrations/001_initial.sql` in the Supabase SQL editor.
3. Put the project URL and public anon key in `assets/js/config.js`.
4. Enable email authentication and add the GitHub Pages URL as an allowed redirect URL.
5. Optional: create an R2 bucket, deploy the worker in `worker/`, and set `R2_WORKER_URL`.

Never place a Supabase service-role key or Cloudflare R2 secret in browser JavaScript.

## Security

Every data table has a `user_id`. Row Level Security requires `auth.uid() = user_id`.

The R2 worker validates the Supabase bearer token before upload and can be locked to one account through `ALLOWED_USER_ID`.

## First milestone

Included now:
- Supabase magic-link login
- member create/edit/delete
- color picker with synced hex value
- external avatar/banner links
- optional R2 uploads
- 2 MB avatar and 5 MB banner limits
- responsive desktop/mobile shell
- schema for groups, fronts, settings, and imports
- GitHub Pages workflow

Next layers:
- Tupperbox import
- PluralKit import and sync
- group management UI
- front tracking
- media replacement and cleanup
- backups and restore
