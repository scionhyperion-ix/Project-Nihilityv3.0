create table if not exists private.instance_config (
  id boolean primary key default true check (id),
  owner_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into private.instance_config(id, owner_email)
values (true, null)
on conflict (id) do nothing;

alter table public.members
  add column if not exists archived_at timestamptz;

create or replace function private.guard_profile_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id
     or lower(new.email) is distinct from lower(old.email)
     or new.role is distinct from old.role then
    raise exception 'Account identity and role cannot be changed from the client';
  end if;
  return new;
end;
$$;

drop trigger if exists nihility_guard_profile_identity on public.profiles;
create trigger nihility_guard_profile_identity
before update on public.profiles
for each row execute function private.guard_profile_identity();

revoke insert, delete on public.profiles from authenticated;
revoke update on public.profiles from authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, avatar_url, avatar_storage_path) on public.profiles to authenticated;

create or replace function private.authorize_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  mail text := lower(coalesce(new.email, ''));
  configured_owner text;
begin
  select lower(owner_email)
  into configured_owner
  from private.instance_config
  where id = true;

  if mail = '' then
    raise exception 'Email is required';
  end if;

  if configured_owner is not null and mail = configured_owner then
    return new;
  end if;

  if exists (
    select 1
    from public.account_invites
    where lower(email) = mail
      and accepted_at is null
  ) then
    return new;
  end if;

  raise exception 'This Nihility instance is invite-only';
end;
$$;

drop trigger if exists nihility_authorize_auth_user on auth.users;
create trigger nihility_authorize_auth_user
before insert on auth.users
for each row execute function private.authorize_new_auth_user();

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  mail text := lower(coalesce(new.email, ''));
  configured_owner text;
begin
  select lower(owner_email)
  into configured_owner
  from private.instance_config
  where id = true;

  if configured_owner is not null and mail = configured_owner then
    insert into public.profiles(user_id,email,display_name,role)
    values(new.id,mail,split_part(mail,'@',1),'owner')
    on conflict (user_id) do nothing;
    return new;
  end if;

  if exists (
    select 1
    from public.account_invites
    where lower(email)=mail and accepted_at is null
  ) then
    insert into public.profiles(user_id,email,display_name,role)
    values(new.id,mail,split_part(mail,'@',1),'member')
    on conflict (user_id) do nothing;

    update public.account_invites
      set accepted_at=now()
      where lower(email)=mail and accepted_at is null;
  end if;

  return new;
end;
$$;

drop trigger if exists nihility_auth_user_bootstrap on auth.users;
create trigger nihility_auth_user_bootstrap
after insert on auth.users
for each row execute function private.handle_new_auth_user();

create or replace function private.handle_new_invite()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_user uuid;
begin
  select id into existing_user
  from auth.users
  where lower(email)=lower(new.email)
  limit 1;

  if existing_user is not null then
    insert into public.profiles(user_id,email,display_name,role)
    values(existing_user,lower(new.email),split_part(lower(new.email),'@',1),'member')
    on conflict (user_id) do nothing;

    new.accepted_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists nihility_invite_accept_existing_user on public.account_invites;
create trigger nihility_invite_accept_existing_user
before insert or update on public.account_invites
for each row execute function private.handle_new_invite();

create or replace function public.log_front(
  p_member_ids uuid[],
  p_started_at timestamptz default now(),
  p_note text default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  new_front uuid;
  member_id uuid;
  effective_started_at timestamptz := coalesce(p_started_at, now());
  active_started_at timestamptz;
begin
  if uid is null then
    raise exception 'Authentication required';
  end if;

  if effective_started_at > now() + interval '5 minutes' then
    raise exception 'Front start time cannot be in the future';
  end if;

  select started_at
  into active_started_at
  from public.fronts
  where user_id=uid and ended_at is null
  order by started_at desc
  limit 1;

  if active_started_at is not null and effective_started_at < active_started_at then
    raise exception 'Start time cannot be earlier than the current front';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_member_ids, array[]::uuid[])) x(id)
    where not exists (
      select 1
      from public.members m
      where m.id=x.id
        and m.user_id=uid
        and m.archived_at is null
    )
  ) then
    raise exception 'One or more selected members are unavailable';
  end if;

  update public.fronts
    set ended_at=effective_started_at
    where user_id=uid and ended_at is null;

  insert into public.fronts(user_id,started_at,note,source)
  values(uid,effective_started_at,p_note,'nihility')
  returning id into new_front;

  foreach member_id in array coalesce(p_member_ids,array[]::uuid[])
  loop
    insert into public.front_members(user_id,front_id,member_id,joined_at)
    values(uid,new_front,member_id,effective_started_at);
  end loop;

  return new_front;
end;
$$;

revoke execute on function public.log_front(uuid[],timestamptz,text) from public;
grant execute on function public.log_front(uuid[],timestamptz,text) to authenticated;
