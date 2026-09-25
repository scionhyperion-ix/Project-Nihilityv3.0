-- Public media used only when a PluralKit system avatar/banner must be
-- reachable by PluralKit. All private Nihility media remains in private buckets.
--
-- Browser roles get no write policy for this bucket. Objects are written only
-- by the authenticated nihility-secure Edge Function using service_role after
-- the same image validation used for private media.

insert into storage.buckets
  (id,name,public,file_size_limit,allowed_mime_types)
values
  (
    'nihility-pk-system-media',
    'nihility-pk-system-media',
    true,
    5242880,
    array['image/png','image/jpeg','image/webp','image/gif']
  )
on conflict (id) do update set
  public=excluded.public,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

-- Registry is intentionally browser-inaccessible. It lets the Edge Function
-- prove which public object belongs to which account before replacing/deleting.
create table if not exists public.pk_system_media_registry (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('avatar','banner')),
  object_path text not null unique
    check (
      object_path ~ '^(avatar|banner)/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp|gif)$'
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id,kind),
  check (split_part(object_path,'/',1)=kind)
);

alter table public.pk_system_media_registry enable row level security;

drop policy if exists "pk_system_media_registry_deny_browser"
  on public.pk_system_media_registry;
create policy "pk_system_media_registry_deny_browser"
on public.pk_system_media_registry
for all
to anon,authenticated
using (false)
with check (false);

revoke all on public.pk_system_media_registry from public,anon,authenticated;
grant select,insert,update,delete on public.pk_system_media_registry to service_role;

-- Browser uploads are intentionally disabled globally. Private media and the
-- public PluralKit bucket are uploaded only through nihility-secure.
revoke insert,update on storage.objects from anon,authenticated;

-- Client code never creates or mutates buckets.
revoke insert,update,delete,truncate,references,trigger
  on storage.buckets from anon,authenticated;

-- No storage.objects policy is created for nihility-pk-system-media.
-- Public bucket reads are public by design, while writes still require RLS or
-- service_role. This keeps PluralKit-compatible URLs public without granting
-- browser-side write access.
