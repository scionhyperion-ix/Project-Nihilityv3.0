drop policy if exists "nihility_media_insert_own" on storage.objects;
drop policy if exists "nihility_media_select_own" on storage.objects;
drop policy if exists "nihility_media_delete_own" on storage.objects;

create policy "nihility_media_insert_own"
on storage.objects for insert to authenticated
with check (
  bucket_id in ('nihility-avatars','nihility-banners','nihility-profile-avatars')
  and owner_id = (select auth.uid()::text)
  and exists (select 1 from public.profiles p where p.user_id=(select auth.uid()))
);

create policy "nihility_media_select_own"
on storage.objects for select to authenticated
using (
  bucket_id in ('nihility-avatars','nihility-banners','nihility-profile-avatars')
  and owner_id = (select auth.uid()::text)
  and exists (select 1 from public.profiles p where p.user_id=(select auth.uid()))
);

create policy "nihility_media_delete_own"
on storage.objects for delete to authenticated
using (
  bucket_id in ('nihility-avatars','nihility-banners','nihility-profile-avatars')
  and owner_id = (select auth.uid()::text)
  and exists (select 1 from public.profiles p where p.user_id=(select auth.uid()))
);

drop policy if exists "members_owner_all" on public.members;
create policy "members_owner_all" on public.members
for all to authenticated
using (user_id=(select auth.uid()) and exists (select 1 from public.profiles p where p.user_id=(select auth.uid())))
with check (user_id=(select auth.uid()) and exists (select 1 from public.profiles p where p.user_id=(select auth.uid())));

drop policy if exists "groups_owner_all" on public.groups;
create policy "groups_owner_all" on public.groups
for all to authenticated
using (user_id=(select auth.uid()) and exists (select 1 from public.profiles p where p.user_id=(select auth.uid())))
with check (user_id=(select auth.uid()) and exists (select 1 from public.profiles p where p.user_id=(select auth.uid())));

drop policy if exists "member_groups_owner_all" on public.member_groups;
create policy "member_groups_owner_all" on public.member_groups
for all to authenticated
using (user_id=(select auth.uid()) and exists (select 1 from public.profiles p where p.user_id=(select auth.uid())))
with check (user_id=(select auth.uid()) and exists (select 1 from public.profiles p where p.user_id=(select auth.uid())));

drop policy if exists "fronts_owner_all" on public.fronts;
create policy "fronts_owner_all" on public.fronts
for all to authenticated
using (user_id=(select auth.uid()) and exists (select 1 from public.profiles p where p.user_id=(select auth.uid())))
with check (user_id=(select auth.uid()) and exists (select 1 from public.profiles p where p.user_id=(select auth.uid())));

drop policy if exists "front_members_owner_all" on public.front_members;
create policy "front_members_owner_all" on public.front_members
for all to authenticated
using (user_id=(select auth.uid()) and exists (select 1 from public.profiles p where p.user_id=(select auth.uid())))
with check (user_id=(select auth.uid()) and exists (select 1 from public.profiles p where p.user_id=(select auth.uid())));

drop policy if exists "app_settings_owner_all" on public.app_settings;
create policy "app_settings_owner_all" on public.app_settings
for all to authenticated
using (user_id=(select auth.uid()) and exists (select 1 from public.profiles p where p.user_id=(select auth.uid())))
with check (user_id=(select auth.uid()) and exists (select 1 from public.profiles p where p.user_id=(select auth.uid())));

drop policy if exists "imports_owner_all" on public.imports;
create policy "imports_owner_all" on public.imports
for all to authenticated
using (user_id=(select auth.uid()) and exists (select 1 from public.profiles p where p.user_id=(select auth.uid())))
with check (user_id=(select auth.uid()) and exists (select 1 from public.profiles p where p.user_id=(select auth.uid())));

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists integrations_set_updated_at on public.external_integrations;
create trigger integrations_set_updated_at before update on public.external_integrations
for each row execute function public.set_updated_at();
