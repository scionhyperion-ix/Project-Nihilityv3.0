-- Post-deploy front integrity hardening.
-- Keeps the browser's write capability narrow while enforcing front timing at
-- the database boundary for both RPCs and direct authenticated requests.

grant update (left_at) on table public.front_members to authenticated;

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.front_members'::regclass
      and conname='front_members_time_order_chk'
  ) then
    alter table public.front_members
      add constraint front_members_time_order_chk
      check (left_at is null or left_at >= joined_at);
  end if;
end
$constraints$;

create unique index if not exists fronts_one_active_per_user
  on public.fronts(user_id)
  where ended_at is null;

create or replace function private.guard_front_member_timing()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_started_at timestamptz;
  v_ended_at timestamptz;
begin
  select f.started_at,f.ended_at
    into v_started_at,v_ended_at
  from public.fronts f
  where f.id=new.front_id
    and f.user_id=new.user_id;

  if not found then
    raise exception 'Front does not belong to this account';
  end if;

  if new.joined_at < v_started_at then
    raise exception 'A fronter cannot join before the front starts';
  end if;

  if v_ended_at is not null and new.joined_at > v_ended_at then
    raise exception 'A fronter cannot join after the front ends';
  end if;

  if new.left_at is not null then
    if new.left_at < new.joined_at then
      raise exception 'A fronter cannot leave before joining';
    end if;
    if v_ended_at is not null and new.left_at > v_ended_at then
      raise exception 'A fronter cannot leave after the front ends';
    end if;
  end if;

  return new;
end
$$;

revoke all on function private.guard_front_member_timing()
  from public,anon,authenticated;

drop trigger if exists nihility_guard_front_member_timing on public.front_members;
create trigger nihility_guard_front_member_timing
before insert or update of front_id,user_id,joined_at,left_at
on public.front_members
for each row execute function private.guard_front_member_timing();

create or replace function private.guard_front_boundaries()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.ended_at is not null then
    if exists (
      select 1
      from public.front_members fm
      where fm.front_id=new.id
        and fm.user_id=new.user_id
        and (
          fm.joined_at > new.ended_at
          or (fm.left_at is not null and fm.left_at > new.ended_at)
        )
    ) then
      raise exception 'Front end time would exclude existing fronter timing';
    end if;
  end if;
  return new;
end
$$;

revoke all on function private.guard_front_boundaries()
  from public,anon,authenticated;

drop trigger if exists nihility_guard_front_boundaries on public.fronts;
create trigger nihility_guard_front_boundaries
before update of started_at,ended_at
on public.fronts
for each row execute function private.guard_front_boundaries();

create or replace function private.close_front_member_timing()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.ended_at is not null
     and old.ended_at is distinct from new.ended_at then
    update public.front_members
      set left_at=new.ended_at
    where front_id=new.id
      and user_id=new.user_id
      and left_at is null;
  end if;
  return new;
end
$$;

revoke all on function private.close_front_member_timing()
  from public,anon,authenticated;

drop trigger if exists nihility_close_front_member_timing on public.fronts;
create trigger nihility_close_front_member_timing
after update of ended_at
on public.fronts
for each row execute function private.close_front_member_timing();

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
  v_details jsonb;
begin
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('member_id',x.id)
    ),
    '[]'::jsonb
  )
  into v_details
  from pg_catalog.unnest(coalesce(p_member_ids,array[]::uuid[])) x(id);

  return public.log_front_detailed(v_details,p_started_at,p_note);
end
$$;

revoke all on function public.log_front(uuid[],timestamptz,text)
  from public,anon;
grant execute on function public.log_front(uuid[],timestamptz,text)
  to authenticated,service_role;
