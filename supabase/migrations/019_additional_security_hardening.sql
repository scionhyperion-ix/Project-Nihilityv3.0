-- Additional defense-in-depth hardening.
-- 1) Keep only the path-based private-media policies used by all current media.
-- 2) Add covering indexes for tenant-aware foreign keys.
-- 3) Allow the Edge Function to reject JWTs whose Supabase session was revoked.

drop policy if exists "nihility_media_select_own" on storage.objects;
drop policy if exists "nihility_media_delete_own" on storage.objects;

create index if not exists front_members_front_owner_idx
  on public.front_members(front_id, user_id);

create index if not exists front_members_member_owner_idx
  on public.front_members(member_id, user_id);

create index if not exists member_groups_member_owner_idx
  on public.member_groups(member_id, user_id);

create index if not exists member_groups_group_owner_idx
  on public.member_groups(group_id, user_id);

create or replace function public.is_nihility_session_active(
  p_user_id uuid,
  p_session_id uuid
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.sessions s
    where s.id = p_session_id
      and s.user_id = p_user_id
      and (s.not_after is null or s.not_after > pg_catalog.now())
  )
$$;

revoke all on function public.is_nihility_session_active(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.is_nihility_session_active(uuid,uuid)
  to service_role;
