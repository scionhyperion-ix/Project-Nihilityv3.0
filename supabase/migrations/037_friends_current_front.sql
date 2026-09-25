-- Mutual Friends with deliberately narrow current-front sharing.
-- Cross-account data stays inaccessible through ordinary table RLS. Authenticated
-- clients use only the RPCs below, which return a minimal allow-listed payload.

create table public.friend_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  friend_code text not null unique,
  share_front boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friend_settings_code_format check (friend_code ~ '^[0-9A-F]{20}$')
);

create table public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  addressee_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friendships_distinct_users check (requester_id <> addressee_id),
  constraint friendships_status_check check (status in ('pending','accepted'))
);

create unique index friendships_unique_pair
on public.friendships (
  least(requester_id,addressee_id),
  greatest(requester_id,addressee_id)
);

create index friendships_requester_status_idx
  on public.friendships(requester_id,status,updated_at desc);
create index friendships_addressee_status_idx
  on public.friendships(addressee_id,status,updated_at desc);

create trigger friend_settings_set_updated_at
before update on public.friend_settings
for each row execute function public.set_updated_at();

create trigger friendships_set_updated_at
before update on public.friendships
for each row execute function public.set_updated_at();

alter table public.friend_settings enable row level security;
alter table public.friendships enable row level security;

create policy friend_settings_deny_browser
on public.friend_settings
for all
to anon,authenticated
using (false)
with check (false);

create policy friendships_deny_browser
on public.friendships
for all
to anon,authenticated
using (false)
with check (false);

revoke all on public.friend_settings from public,anon,authenticated;
revoke all on public.friendships from public,anon,authenticated;
grant select,insert,update,delete on public.friend_settings to service_role;
grant select,insert,update,delete on public.friendships to service_role;

create or replace function private.new_friend_code()
returns text
language plpgsql
security definer
set search_path=''
as $friend_code$
declare
  v_code text;
begin
  loop
    v_code:=pg_catalog.upper(pg_catalog.encode(extensions.gen_random_bytes(10),'hex'));
    exit when not exists(
      select 1 from public.friend_settings fs where fs.friend_code=v_code
    );
  end loop;
  return v_code;
end
$friend_code$;

revoke all on function private.new_friend_code() from public,anon,authenticated;

create or replace function private.ensure_friend_settings()
returns trigger
language plpgsql
security definer
set search_path=''
as $friend_settings$
begin
  insert into public.friend_settings(user_id,friend_code)
  values(new.user_id,private.new_friend_code())
  on conflict (user_id) do nothing;
  return new;
end
$friend_settings$;

revoke all on function private.ensure_friend_settings() from public,anon,authenticated;

create trigger nihility_profile_friend_settings
after insert on public.profiles
for each row execute function private.ensure_friend_settings();

insert into public.friend_settings(user_id,friend_code)
select p.user_id,private.new_friend_code()
from public.profiles p
where not exists(
  select 1 from public.friend_settings fs where fs.user_id=p.user_id
);

create or replace function public.friend_dashboard()
returns jsonb
language plpgsql
security definer
set search_path=''
as $friends$
declare
  v_uid uuid;
  v_settings public.friend_settings%rowtype;
begin
  v_uid:=auth.uid();
  if v_uid is null or not exists(select 1 from public.profiles p where p.user_id=v_uid) then
    raise exception 'A Nihility profile is required';
  end if;

  select * into v_settings
  from public.friend_settings fs
  where fs.user_id=v_uid;

  if not found then
    insert into public.friend_settings(user_id,friend_code)
    values(v_uid,private.new_friend_code())
    returning * into v_settings;
  end if;

  return pg_catalog.jsonb_build_object(
    'friend_code',v_settings.friend_code,
    'share_front',v_settings.share_front,
    'incoming',coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'friendship_id',f.id,
          'display_name',coalesce(p.display_name,'Nihility user'),
          'created_at',f.created_at
        )
        order by f.created_at
      )
      from public.friendships f
      join public.profiles p on p.user_id=f.requester_id
      where f.addressee_id=v_uid and f.status='pending'
    ),'[]'::jsonb),
    'outgoing',coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'friendship_id',f.id,
          'display_name',coalesce(p.display_name,'Nihility user'),
          'created_at',f.created_at
        )
        order by f.created_at
      )
      from public.friendships f
      join public.profiles p on p.user_id=f.addressee_id
      where f.requester_id=v_uid and f.status='pending'
    ),'[]'::jsonb),
    'friends',coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'friendship_id',x.friendship_id,
          'display_name',coalesce(p.display_name,'Nihility friend'),
          'sharing_enabled',coalesce(fs.share_front,false),
          'fronters',
            case
              when coalesce(fs.share_front,false) then coalesce((
                select pg_catalog.jsonb_agg(
                  pg_catalog.jsonb_build_object(
                    'display_name',coalesce(m.display_name,m.name,'Member'),
                    'pronouns',m.pronouns,
                    'color',m.color,
                    'joined_at',coalesce(fm.joined_at,cf.started_at)
                  )
                  order by coalesce(fm.joined_at,cf.started_at),coalesce(m.display_name,m.name)
                )
                from public.front_members fm
                join public.members m
                  on m.id=fm.member_id and m.user_id=x.friend_user_id
                where cf.id is not null
                  and fm.user_id=x.friend_user_id
                  and fm.front_id=cf.id
                  and fm.left_at is null
              ),'[]'::jsonb)
              else '[]'::jsonb
            end
        )
        order by pg_catalog.lower(coalesce(p.display_name,'Nihility friend'))
      )
      from (
        select
          f.id as friendship_id,
          case when f.requester_id=v_uid then f.addressee_id else f.requester_id end as friend_user_id
        from public.friendships f
        where f.status='accepted'
          and (f.requester_id=v_uid or f.addressee_id=v_uid)
      ) x
      join public.profiles p on p.user_id=x.friend_user_id
      left join public.friend_settings fs on fs.user_id=x.friend_user_id
      left join lateral (
        select fr.id,fr.started_at
        from public.fronts fr
        where fr.user_id=x.friend_user_id
          and fr.ended_at is null
        order by fr.started_at desc
        limit 1
      ) cf on true
    ),'[]'::jsonb)
  );
end
$friends$;

create or replace function public.friend_request(p_friend_code text)
returns uuid
language plpgsql
security definer
set search_path=''
as $friends$
declare
  v_uid uuid;
  v_code text;
  v_target uuid;
  v_id uuid;
  v_lock_a bigint;
  v_lock_b bigint;
begin
  v_uid:=auth.uid();
  if v_uid is null or not exists(select 1 from public.profiles p where p.user_id=v_uid) then
    raise exception 'A Nihility profile is required';
  end if;

  v_code:=pg_catalog.upper(pg_catalog.regexp_replace(coalesce(p_friend_code,''),'[^0-9A-Fa-f]','','g'));
  if pg_catalog.length(v_code)<>20 then
    raise exception 'Enter a valid Friend Code';
  end if;

  select fs.user_id into v_target
  from public.friend_settings fs
  where fs.friend_code=v_code;

  if v_target is null then
    raise exception 'No Nihility user was found with that Friend Code';
  end if;
  if v_target=v_uid then
    raise exception 'You cannot add yourself';
  end if;

  v_lock_a:=pg_catalog.hashtextextended(least(v_uid::text,v_target::text),0);
  v_lock_b:=pg_catalog.hashtextextended(greatest(v_uid::text,v_target::text),0);
  perform pg_catalog.pg_advisory_xact_lock(least(v_lock_a,v_lock_b));
  perform pg_catalog.pg_advisory_xact_lock(greatest(v_lock_a,v_lock_b));

  if exists(
    select 1 from public.friendships f
    where (f.requester_id=v_uid and f.addressee_id=v_target)
       or (f.requester_id=v_target and f.addressee_id=v_uid)
  ) then
    raise exception 'A friend request or friendship already exists';
  end if;

  insert into public.friendships(requester_id,addressee_id)
  values(v_uid,v_target)
  returning id into v_id;

  return v_id;
end
$friends$;

create or replace function public.friend_respond(p_friendship_id uuid,p_accept boolean)
returns void
language plpgsql
security definer
set search_path=''
as $friends$
declare
  v_uid uuid;
  v_row public.friendships%rowtype;
begin
  v_uid:=auth.uid();
  if v_uid is null then raise exception 'Sign in required'; end if;

  select * into v_row
  from public.friendships f
  where f.id=p_friendship_id
    and f.addressee_id=v_uid
    and f.status='pending'
  for update;

  if not found then raise exception 'Friend request not found'; end if;

  if coalesce(p_accept,false) then
    update public.friendships
    set status='accepted'
    where id=v_row.id;
  else
    delete from public.friendships where id=v_row.id;
  end if;
end
$friends$;

create or replace function public.friend_remove(p_friendship_id uuid)
returns void
language plpgsql
security definer
set search_path=''
as $friends$
declare
  v_uid uuid;
begin
  v_uid:=auth.uid();
  if v_uid is null then raise exception 'Sign in required'; end if;

  delete from public.friendships f
  where f.id=p_friendship_id
    and f.status='accepted'
    and (f.requester_id=v_uid or f.addressee_id=v_uid);

  if not found then raise exception 'Friendship not found'; end if;
end
$friends$;

create or replace function public.friend_cancel_request(p_friendship_id uuid)
returns void
language plpgsql
security definer
set search_path=''
as $friends$
declare
  v_uid uuid;
begin
  v_uid:=auth.uid();
  if v_uid is null then raise exception 'Sign in required'; end if;

  delete from public.friendships f
  where f.id=p_friendship_id
    and f.status='pending'
    and f.requester_id=v_uid;

  if not found then raise exception 'Pending request not found'; end if;
end
$friends$;

create or replace function public.friend_set_sharing(p_enabled boolean)
returns void
language plpgsql
security definer
set search_path=''
as $friends$
declare
  v_uid uuid;
begin
  v_uid:=auth.uid();
  if v_uid is null or not exists(select 1 from public.profiles p where p.user_id=v_uid) then
    raise exception 'A Nihility profile is required';
  end if;

  insert into public.friend_settings(user_id,friend_code,share_front)
  values(v_uid,private.new_friend_code(),coalesce(p_enabled,false))
  on conflict (user_id) do update
  set share_front=excluded.share_front;
end
$friends$;

revoke all on function public.friend_dashboard() from public,anon;
revoke all on function public.friend_request(text) from public,anon;
revoke all on function public.friend_respond(uuid,boolean) from public,anon;
revoke all on function public.friend_remove(uuid) from public,anon;
revoke all on function public.friend_cancel_request(uuid) from public,anon;
revoke all on function public.friend_set_sharing(boolean) from public,anon;

grant execute on function public.friend_dashboard() to authenticated;
grant execute on function public.friend_request(text) to authenticated;
grant execute on function public.friend_respond(uuid,boolean) to authenticated;
grant execute on function public.friend_remove(uuid) to authenticated;
grant execute on function public.friend_cancel_request(uuid) to authenticated;
grant execute on function public.friend_set_sharing(boolean) to authenticated;
