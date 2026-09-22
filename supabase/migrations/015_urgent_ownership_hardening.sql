-- Urgent ownership hardening.
-- 1) Browser uploads must live under the authenticated user's own folder.
-- 2) Join tables must reference members/groups/fronts owned by the same user.

drop policy if exists "nihility_media_insert_own" on storage.objects;
create policy "nihility_media_insert_own"
on storage.objects
for insert
to authenticated
with check (
  bucket_id in ('nihility-avatars','nihility-banners','nihility-profile-avatars')
  and owner_id = (select auth.uid()::text)
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and exists (
    select 1
    from public.profiles p
    where p.user_id = (select auth.uid())
  )
);

-- Composite uniqueness gives PostgreSQL a tenant-aware FK target.
alter table public.members
  add constraint members_id_user_unique unique (id, user_id);

alter table public.groups
  add constraint groups_id_user_unique unique (id, user_id);

alter table public.fronts
  add constraint fronts_id_user_unique unique (id, user_id);

-- A membership can only connect records belonging to the same account.
alter table public.member_groups
  add constraint member_groups_member_owner_fkey
  foreign key (member_id, user_id)
  references public.members (id, user_id)
  on delete cascade;

alter table public.member_groups
  add constraint member_groups_group_owner_fkey
  foreign key (group_id, user_id)
  references public.groups (id, user_id)
  on delete cascade;

-- A front-member row can only connect a front and member from the same account.
alter table public.front_members
  add constraint front_members_front_owner_fkey
  foreign key (front_id, user_id)
  references public.fronts (id, user_id)
  on delete cascade;

alter table public.front_members
  add constraint front_members_member_owner_fkey
  foreign key (member_id, user_id)
  references public.members (id, user_id)
  on delete cascade;
