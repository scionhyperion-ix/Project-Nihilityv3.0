create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  avatar_url text,
  avatar_storage_path text,
  role text not null default 'member' check (role in ('owner','member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.account_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  invited_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

create table if not exists public.external_integrations (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('pluralkit','tupperbox')),
  external_system_id text,
  external_system_name text,
  share_fronting_updates boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  connected_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table public.members add constraint members_user_pk_unique unique (user_id, pk_id);
alter table public.groups add constraint groups_user_pk_unique unique (user_id, pk_id);
create unique index if not exists fronts_external_unique on public.fronts(user_id, source, external_id) where external_id is not null;

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('nihility-profile-avatars','nihility-profile-avatars',true,2097152,array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do update set public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

alter table public.profiles enable row level security;
alter table public.account_invites enable row level security;
alter table public.external_integrations enable row level security;

create policy "profile_read_own" on public.profiles for select to authenticated using (user_id=(select auth.uid()));
create policy "profile_update_own" on public.profiles for update to authenticated using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
create policy "integration_owner_all" on public.external_integrations for all to authenticated using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
create policy "owner_manage_invites" on public.account_invites for all to authenticated
using (exists(select 1 from public.profiles p where p.user_id=(select auth.uid()) and p.role='owner'))
with check (exists(select 1 from public.profiles p where p.user_id=(select auth.uid()) and p.role='owner'));

create or replace function public.bootstrap_or_accept_profile()
returns public.profiles language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); mail text:=lower(coalesce(auth.jwt()->>'email','')); existing public.profiles; result_row public.profiles;
begin
  if uid is null or mail='' then raise exception 'Authentication required'; end if;
  select * into existing from public.profiles where user_id=uid;if found then return existing;end if;
  if not exists(select 1 from public.profiles) then
    insert into public.profiles(user_id,email,display_name,role) values(uid,mail,split_part(mail,'@',1),'owner') returning * into result_row;return result_row;
  end if;
  if exists(select 1 from public.account_invites where lower(email)=mail and accepted_at is null) then
    insert into public.profiles(user_id,email,display_name,role) values(uid,mail,split_part(mail,'@',1),'member') returning * into result_row;
    update public.account_invites set accepted_at=now() where lower(email)=mail and accepted_at is null;return result_row;
  end if;
  raise exception 'This Nihility instance is invite-only';
end;$$;
revoke all on function public.bootstrap_or_accept_profile() from public;
grant execute on function public.bootstrap_or_accept_profile() to authenticated;

create or replace function public.invite_account(p_email text)
returns uuid language plpgsql security definer set search_path='' as $$
declare invite_id uuid;
begin
  if not exists(select 1 from public.profiles where user_id=auth.uid() and role='owner') then raise exception 'Only the owner can invite accounts';end if;
  insert into public.account_invites(email,invited_by) values(lower(trim(p_email)),auth.uid())
  on conflict(email) do update set invited_by=excluded.invited_by,accepted_at=null,created_at=now()
  returning id into invite_id;return invite_id;
end;$$;
revoke all on function public.invite_account(text) from public;
grant execute on function public.invite_account(text) to authenticated;

create or replace function public.log_front(p_member_ids uuid[],p_started_at timestamptz default now(),p_note text default null)
returns uuid language plpgsql security invoker set search_path='' as $$
declare uid uuid:=auth.uid();new_front uuid;member_id uuid;
begin
  if uid is null then raise exception 'Authentication required';end if;
  if exists(select 1 from unnest(coalesce(p_member_ids,array[]::uuid[])) x(id) where not exists(select 1 from public.members m where m.id=x.id and m.user_id=uid)) then raise exception 'One or more members do not belong to this account';end if;
  update public.fronts set ended_at=p_started_at where user_id=uid and ended_at is null;
  insert into public.fronts(user_id,started_at,note,source) values(uid,p_started_at,p_note,'nihility') returning id into new_front;
  foreach member_id in array coalesce(p_member_ids,array[]::uuid[]) loop
    insert into public.front_members(user_id,front_id,member_id,joined_at) values(uid,new_front,member_id,p_started_at);
  end loop;
  return new_front;
end;$$;
grant execute on function public.log_front(uuid[],timestamptz,text) to authenticated;
