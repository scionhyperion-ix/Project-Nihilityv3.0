-- Allow authenticated users to read and delete private media stored under
-- their own user-id path. This also covers media imported server-side by the
-- Nihility Edge Function, whose storage owner_id is the service role.

-- The original owner_id policies remain useful for direct browser uploads.
-- These path-scoped policies add access for server-imported objects without
-- making any bucket public.

drop policy if exists "nihility_media_select_own_path" on storage.objects;
create policy "nihility_media_select_own_path"
on storage.objects for select to authenticated
using (
  bucket_id in ('nihility-avatars','nihility-banners','nihility-profile-avatars')
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "nihility_media_delete_own_path" on storage.objects;
create policy "nihility_media_delete_own_path"
on storage.objects for delete to authenticated
using (
  bucket_id in ('nihility-avatars','nihility-banners','nihility-profile-avatars')
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);
