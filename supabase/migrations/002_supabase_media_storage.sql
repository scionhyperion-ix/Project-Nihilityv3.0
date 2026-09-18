alter table public.members
  add column if not exists avatar_storage_path text,
  add column if not exists banner_storage_path text;

alter table public.groups
  add column if not exists icon_storage_path text;

alter table public.members drop constraint if exists members_avatar_source_check;
alter table public.members add constraint members_avatar_source_check
  check (avatar_source is null or avatar_source in ('external','supabase'));

alter table public.members drop constraint if exists members_banner_source_check;
alter table public.members add constraint members_banner_source_check
  check (banner_source is null or banner_source in ('external','supabase'));

alter table public.groups drop constraint if exists groups_icon_source_check;
alter table public.groups add constraint groups_icon_source_check
  check (icon_source is null or icon_source in ('external','supabase'));

insert into storage.buckets
  (id, name, public, file_size_limit, allowed_mime_types)
values
  ('nihility-avatars', 'nihility-avatars', true, 2097152,
   array['image/png','image/jpeg','image/webp','image/gif']),
  ('nihility-banners', 'nihility-banners', true, 5242880,
   array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "nihility_media_insert_own"
on storage.objects for insert to authenticated
with check (
  bucket_id in ('nihility-avatars','nihility-banners')
  and owner_id = (select auth.uid()::text)
);

create policy "nihility_media_select_own"
on storage.objects for select to authenticated
using (
  bucket_id in ('nihility-avatars','nihility-banners')
  and owner_id = (select auth.uid()::text)
);

create policy "nihility_media_delete_own"
on storage.objects for delete to authenticated
using (
  bucket_id in ('nihility-avatars','nihility-banners')
  and owner_id = (select auth.uid()::text)
);
