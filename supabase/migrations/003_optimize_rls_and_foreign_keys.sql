drop policy if exists "members_owner_all" on public.members;
create policy "members_owner_all" on public.members
for all using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);

drop policy if exists "groups_owner_all" on public.groups;
create policy "groups_owner_all" on public.groups
for all using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);

drop policy if exists "member_groups_owner_all" on public.member_groups;
create policy "member_groups_owner_all" on public.member_groups
for all using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);

drop policy if exists "fronts_owner_all" on public.fronts;
create policy "fronts_owner_all" on public.fronts
for all using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);

drop policy if exists "front_members_owner_all" on public.front_members;
create policy "front_members_owner_all" on public.front_members
for all using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);

drop policy if exists "app_settings_owner_all" on public.app_settings;
create policy "app_settings_owner_all" on public.app_settings
for all using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);

drop policy if exists "imports_owner_all" on public.imports;
create policy "imports_owner_all" on public.imports
for all using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);

create index if not exists front_members_member_id_idx on public.front_members(member_id);
create index if not exists front_members_user_id_idx on public.front_members(user_id);
create index if not exists imports_user_id_idx on public.imports(user_id);
create index if not exists member_groups_group_id_idx on public.member_groups(group_id);
create index if not exists member_groups_user_id_idx on public.member_groups(user_id);
