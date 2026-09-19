-- Least-privilege grants for Nihility.
revoke all privileges on all tables in schema public from anon;
revoke all privileges on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon;
revoke execute on all functions in schema private from public, anon, authenticated;

-- Remove broad default privileges from authenticated users.
revoke all privileges on public.members from authenticated;
revoke all privileges on public.groups from authenticated;
revoke all privileges on public.member_groups from authenticated;
revoke all privileges on public.fronts from authenticated;
revoke all privileges on public.front_members from authenticated;
revoke all privileges on public.app_settings from authenticated;
revoke all privileges on public.imports from authenticated;
revoke all privileges on public.account_invites from authenticated;
revoke all privileges on public.external_integrations from authenticated;
revoke all privileges on public.profiles from authenticated;

-- Grant only operations used by the application.
grant select, insert, update on public.members to authenticated;
grant select, insert, update, delete on public.groups to authenticated;
grant select, insert, update, delete on public.member_groups to authenticated;
grant select, insert, update on public.fronts to authenticated;
grant select, insert on public.front_members to authenticated;
grant select, insert, update, delete on public.app_settings to authenticated;
grant select, insert on public.imports to authenticated;
grant select, insert, delete on public.account_invites to authenticated;
grant select, insert, update, delete on public.external_integrations to authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, avatar_url, avatar_storage_path) on public.profiles to authenticated;

-- RPC exposure.
revoke execute on function public.log_front(uuid[],timestamptz,text) from public, anon;
grant execute on function public.log_front(uuid[],timestamptz,text) to authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- Media no longer needs to be public because external integrations only mirror front state.
update storage.buckets
set public = false
where id in ('nihility-avatars','nihility-banners','nihility-profile-avatars');
