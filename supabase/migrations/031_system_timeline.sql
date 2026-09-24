-- System timeline event stream.
-- Browser roles can read their own events but cannot create, edit, or delete
-- timeline rows directly. Database triggers are the authoritative writers.

create table public.system_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  occurred_at timestamptz not null default now(),
  member_id uuid,
  related_member_id uuid,
  group_id uuid,
  front_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint system_events_member_owner_fkey
    foreign key(member_id,user_id) references public.members(id,user_id) on delete cascade,
  constraint system_events_related_member_owner_fkey
    foreign key(related_member_id,user_id) references public.members(id,user_id) on delete cascade,
  constraint system_events_group_owner_fkey
    foreign key(group_id,user_id) references public.groups(id,user_id) on delete cascade,
  constraint system_events_front_owner_fkey
    foreign key(front_id,user_id) references public.fronts(id,user_id) on delete cascade,
  constraint system_events_event_type_check check (
    event_type in (
      'front_logged',
      'member_created',
      'member_archived',
      'member_restored',
      'group_created',
      'member_group_added',
      'member_group_removed',
      'connection_added',
      'connection_updated',
      'connection_removed',
      'integration_imported',
      'integration_synced',
      'backup_restored'
    )
  ),
  constraint system_events_metadata_object_check check (jsonb_typeof(metadata)='object'),
  constraint system_events_metadata_size_check check (octet_length(metadata::text) <= 8192)
);

create index system_events_user_time_idx
  on public.system_events(user_id,occurred_at desc,id desc);
create index system_events_member_owner_idx
  on public.system_events(member_id,user_id)
  where member_id is not null;
create index system_events_related_member_owner_idx
  on public.system_events(related_member_id,user_id)
  where related_member_id is not null;
create index system_events_group_owner_idx
  on public.system_events(group_id,user_id)
  where group_id is not null;
create index system_events_front_owner_idx
  on public.system_events(front_id,user_id)
  where front_id is not null;

alter table public.system_events enable row level security;

create policy system_events_read_own
on public.system_events
for select
to authenticated
using (
  user_id=(select auth.uid())
  and exists(
    select 1
    from public.profiles p
    where p.user_id=(select auth.uid())
  )
);

revoke all on public.system_events from anon,authenticated;
grant select on public.system_events to authenticated;
grant select,insert,update,delete on public.system_events to service_role;

create or replace function private.capture_member_timeline()
returns trigger
language plpgsql
security definer
set search_path=''
as $timeline$
begin
  if coalesce(pg_catalog.current_setting('nihility.suppress_timeline',true),'')='on' then
    return new;
  end if;

  if tg_op='INSERT' then
    insert into public.system_events(user_id,event_type,occurred_at,member_id)
    values(new.user_id,'member_created',new.created_at,new.id);
  elsif tg_op='UPDATE' and old.archived_at is distinct from new.archived_at then
    if old.archived_at is null and new.archived_at is not null then
      insert into public.system_events(user_id,event_type,occurred_at,member_id)
      values(new.user_id,'member_archived',new.archived_at,new.id);
    elsif old.archived_at is not null and new.archived_at is null then
      insert into public.system_events(user_id,event_type,occurred_at,member_id)
      values(new.user_id,'member_restored',pg_catalog.clock_timestamp(),new.id);
    end if;
  end if;
  return new;
end
$timeline$;

revoke all on function private.capture_member_timeline() from public,anon,authenticated;

create trigger nihility_member_timeline_insert
after insert on public.members
for each row execute function private.capture_member_timeline();

create trigger nihility_member_timeline_archive
after update of archived_at on public.members
for each row execute function private.capture_member_timeline();

create or replace function private.capture_group_timeline()
returns trigger
language plpgsql
security definer
set search_path=''
as $timeline$
begin
  if coalesce(pg_catalog.current_setting('nihility.suppress_timeline',true),'')='on' then
    return new;
  end if;
  insert into public.system_events(user_id,event_type,occurred_at,group_id)
  values(new.user_id,'group_created',new.created_at,new.id);
  return new;
end
$timeline$;

revoke all on function private.capture_group_timeline() from public,anon,authenticated;

create trigger nihility_group_timeline_insert
after insert on public.groups
for each row execute function private.capture_group_timeline();

create or replace function private.capture_member_group_timeline()
returns trigger
language plpgsql
security definer
set search_path=''
as $timeline$
begin
  if coalesce(pg_catalog.current_setting('nihility.suppress_timeline',true),'')='on' then
    return coalesce(new,old);
  end if;

  if tg_op='INSERT' then
    insert into public.system_events(
      user_id,event_type,occurred_at,member_id,group_id
    ) values(
      new.user_id,'member_group_added',new.created_at,new.member_id,new.group_id
    );
    return new;
  end if;

  if exists(
       select 1 from public.members m
       where m.id=old.member_id and m.user_id=old.user_id
     )
     and exists(
       select 1 from public.groups g
       where g.id=old.group_id and g.user_id=old.user_id
     ) then
    insert into public.system_events(
      user_id,event_type,occurred_at,member_id,group_id
    ) values(
      old.user_id,'member_group_removed',pg_catalog.clock_timestamp(),old.member_id,old.group_id
    );
  end if;
  return old;
end
$timeline$;

revoke all on function private.capture_member_group_timeline() from public,anon,authenticated;

create trigger nihility_member_group_timeline_insert
after insert on public.member_groups
for each row execute function private.capture_member_group_timeline();

create trigger nihility_member_group_timeline_delete
after delete on public.member_groups
for each row execute function private.capture_member_group_timeline();

create or replace function private.capture_front_timeline()
returns trigger
language plpgsql
security definer
set search_path=''
as $timeline$
begin
  if coalesce(pg_catalog.current_setting('nihility.suppress_timeline',true),'')='on' then
    return new;
  end if;

  if tg_op='INSERT' then
    insert into public.system_events(user_id,event_type,occurred_at,front_id)
    values(new.user_id,'front_logged',new.started_at,new.id);
  elsif old.started_at is distinct from new.started_at then
    update public.system_events
    set occurred_at=new.started_at
    where user_id=new.user_id
      and front_id=new.id
      and event_type='front_logged';
  end if;
  return new;
end
$timeline$;

revoke all on function private.capture_front_timeline() from public,anon,authenticated;

create trigger nihility_front_timeline_insert
after insert on public.fronts
for each row execute function private.capture_front_timeline();

create trigger nihility_front_timeline_start_update
after update of started_at on public.fronts
for each row execute function private.capture_front_timeline();

create or replace function private.capture_connection_timeline()
returns trigger
language plpgsql
security definer
set search_path=''
as $timeline$
declare
  v_metadata jsonb;
begin
  if coalesce(pg_catalog.current_setting('nihility.suppress_timeline',true),'')='on' then
    return coalesce(new,old);
  end if;

  if tg_op='INSERT' then
    v_metadata:=pg_catalog.jsonb_build_object(
      'source_label',new.source_label,
      'target_label',new.target_label
    );
    insert into public.system_events(
      user_id,event_type,occurred_at,member_id,related_member_id,metadata
    ) values(
      new.user_id,'connection_added',new.created_at,
      new.source_member_id,new.target_member_id,v_metadata
    );
    return new;
  elsif tg_op='UPDATE' then
    if old.source_member_id is not distinct from new.source_member_id
       and old.target_member_id is not distinct from new.target_member_id
       and old.source_label is not distinct from new.source_label
       and old.target_label is not distinct from new.target_label then
      return new;
    end if;

    v_metadata:=pg_catalog.jsonb_build_object(
      'source_label',new.source_label,
      'target_label',new.target_label
    );
    insert into public.system_events(
      user_id,event_type,occurred_at,member_id,related_member_id,metadata
    ) values(
      new.user_id,'connection_updated',new.updated_at,
      new.source_member_id,new.target_member_id,v_metadata
    );
    return new;
  end if;

  if exists(
       select 1 from public.members m
       where m.id=old.source_member_id and m.user_id=old.user_id
     )
     and exists(
       select 1 from public.members m
       where m.id=old.target_member_id and m.user_id=old.user_id
     ) then
    v_metadata:=pg_catalog.jsonb_build_object(
      'source_label',old.source_label,
      'target_label',old.target_label
    );
    insert into public.system_events(
      user_id,event_type,occurred_at,member_id,related_member_id,metadata
    ) values(
      old.user_id,'connection_removed',pg_catalog.clock_timestamp(),
      old.source_member_id,old.target_member_id,v_metadata
    );
  end if;
  return old;
end
$timeline$;

revoke all on function private.capture_connection_timeline() from public,anon,authenticated;

create trigger nihility_connection_timeline_insert
after insert on public.member_connections
for each row execute function private.capture_connection_timeline();

create trigger nihility_connection_timeline_update
after update on public.member_connections
for each row execute function private.capture_connection_timeline();

create trigger nihility_connection_timeline_delete
after delete on public.member_connections
for each row execute function private.capture_connection_timeline();

create or replace function private.capture_import_timeline()
returns trigger
language plpgsql
security definer
set search_path=''
as $timeline$
begin
  if coalesce(pg_catalog.current_setting('nihility.suppress_timeline',true),'')='on' then
    return new;
  end if;

  insert into public.system_events(
    user_id,event_type,occurred_at,metadata
  ) values(
    new.user_id,
    'integration_imported',
    new.created_at,
    pg_catalog.jsonb_build_object('source',new.source)
  );
  return new;
end
$timeline$;

revoke all on function private.capture_import_timeline() from public,anon,authenticated;

create trigger nihility_import_timeline_insert
after insert on public.imports
for each row execute function private.capture_import_timeline();

-- Backfill timeline entries that can be reconstructed exactly from current data.
insert into public.system_events(user_id,event_type,occurred_at,member_id)
select user_id,'member_created',created_at,id
from public.members;

insert into public.system_events(user_id,event_type,occurred_at,member_id)
select user_id,'member_archived',archived_at,id
from public.members
where archived_at is not null;

insert into public.system_events(user_id,event_type,occurred_at,group_id)
select user_id,'group_created',created_at,id
from public.groups;

insert into public.system_events(user_id,event_type,occurred_at,member_id,group_id)
select user_id,'member_group_added',created_at,member_id,group_id
from public.member_groups;

insert into public.system_events(user_id,event_type,occurred_at,front_id)
select user_id,'front_logged',started_at,id
from public.fronts;

insert into public.system_events(
  user_id,event_type,occurred_at,member_id,related_member_id,metadata
)
select
  user_id,
  'connection_added',
  created_at,
  source_member_id,
  target_member_id,
  pg_catalog.jsonb_build_object(
    'source_label',source_label,
    'target_label',target_label
  )
from public.member_connections;

insert into public.system_events(user_id,event_type,occurred_at,metadata)
select
  user_id,
  'integration_imported',
  created_at,
  pg_catalog.jsonb_build_object('source',source)
from public.imports;
