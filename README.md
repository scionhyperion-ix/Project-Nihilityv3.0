# Project Nihility v3.0

Private, storage-backed system workspace.

## Storage model

Project Nihility currently uses Supabase for authentication, structured data, and optional direct media uploads.

### Database
Stores:
- members
- groups
- front history
- notes and metadata
- PluralKit and Tupperbox IDs
- external avatar and banner URLs
- media storage paths
- settings and import history

### Images

Nihility remains link-first. If an external image URL is used, Supabase stores only the URL in the member record.

If an image is uploaded directly, it is stored in Supabase Storage.

Two public-read buckets are used because they have different server-side file limits:
- `nihility-avatars`: 2 MB maximum
- `nihility-banners`: 5 MB maximum

Allowed upload types: PNG, JPEG, WebP, and GIF.

Uploads and deletions require an authenticated Supabase user. Storage policies restrict writes to objects owned by that user. Public-read URLs are used so integrations such as PluralKit or Tupperbox can fetch the images.

## Security

The frontend uses a browser-safe Supabase publishable key in `assets/js/config.js`.

Never put a Supabase secret key or service-role key in frontend code.

Database rows are protected by Row Level Security. Storage writes are protected by authenticated ownership policies.

## Migrations

- `supabase/migrations/001_initial.sql`: initial database schema
- `supabase/migrations/002_supabase_media_storage.sql`: Supabase Storage buckets, media paths, and policies

## Current milestone

Included:
- Supabase magic-link login
- member create/edit/delete
- color picker with synced hex value
- external avatar/banner URLs
- optional Supabase Storage uploads
- browser and server-side media size enforcement
- automatic cleanup when stored images are replaced or their member is deleted
- responsive desktop/mobile shell
- schema for groups, fronts, settings, and imports
- GitHub Pages workflow

Next layers:
- multi-user workspace model
- invitations and partner access
- Tupperbox import
- PluralKit import and sync
- group management UI
- front tracking
- backups and restore
