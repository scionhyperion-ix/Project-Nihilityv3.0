-- Optional front notes and per-fronter details.
-- Details inherit front_members ownership and deletion behavior. No external
-- integration receives these fields automatically.

alter table public.front_members
  add column if not exists note text,
  add column if not exists private_note text,
  add column if not exists mood text,
  add column if not exists context text,
  add column if not exists activity text,
  add column if not exists location text;

do $constraints$
begin
  if not exists (select 1 from pg_constraint where conname='front_members_note_length') then
    alter table public.front_members add constraint front_members_note_length check (note is null or length(note) <= 4000);
  end if;
  if not exists (select 1 from pg_constraint where conname='front_members_private_note_length') then
    alter table public.front_members add constraint front_members_private_note_length check (private_note is null or length(private_note) <= 4000);
  end if;
  if not exists (select 1 from pg_constraint where conname='front_members_mood_length') then
    alter table public.front_members add constraint front_members_mood_length check (mood is null or length(mood) <= 200);
  end if;
  if not exists (select 1 from pg_constraint where conname='front_members_context_length') then
    alter table public.front_members add constraint front_members_context_length check (context is null or length(context) <= 1000);
  end if;
  if not exists (select 1 from pg_constraint where conname='front_members_activity_length') then
    alter table public.front_members add constraint front_members_activity_length check (activity is null or length(activity) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname='front_members_location_length') then
    alter table public.front_members add constraint front_members_location_length check (location is null or length(location) <= 500);
  end if;
end
$constraints$;

create or replace function private.nihility_front_history_snapshot(
  p_user_id uuid,
  p_front_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  with target as (
    select jsonb_build_object(
      'id', f.id,
      'started_at', f.started_at,
      'ended_at', f.ended_at,
      'note', f.note,
      'source', f.source,
      'external_id', f.external_id
    ) as front
    from public.fronts f
    where f.user_id = p_user_id
      and f.id = p_front_id
  ),
  links as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'member_id', fm.member_id,
          'joined_at', fm.joined_at,
          'left_at', fm.left_at,
          'note', fm.note,
          'private_note', fm.private_note,
          'mood', fm.mood,
          'context', fm.context,
          'activity', fm.activity,
          'location', fm.location
        )
        order by fm.member_id, fm.joined_at
      ),
      '[]'::jsonb
    ) as items
    from public.front_members fm
    where fm.user_id = p_user_id
      and fm.front_id = p_front_id
  )
  select jsonb_build_object(
    'revision',
      pg_catalog.md5(
        jsonb_build_object(
          'front', target.front,
          'links', links.items
        )::text
      ),
    'front', target.front,
    'links', links.items
  )
  from target
  cross join links
$$;

revoke all on function private.nihility_front_history_snapshot(uuid,uuid)
  from public, anon, authenticated;
grant execute on function private.nihility_front_history_snapshot(uuid,uuid)
  to service_role;

create or replace function private.validate_nihility_front_history_correction(
  p_user_id uuid,
  p_front_id uuid,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_note text,
  p_source text,
  p_member_links jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_front public.fronts%rowtype;
  v_other public.fronts%rowtype;
  v_old_overlap tstzrange;
  v_new_overlap tstzrange;
  v_existing_overlaps integer := 0;
  v_proposed_overlaps integer := 0;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_source text;
begin
  if p_user_id is null or p_front_id is null then
    raise exception 'Front history entry is required';
  end if;

  select *
  into v_front
  from public.fronts
  where user_id = p_user_id
    and id = p_front_id;

  if not found then
    raise exception 'Front history entry was not found';
  end if;

  if p_started_at is null then
    raise exception 'Front start time is required';
  end if;

  if p_started_at > v_now + interval '5 minutes' then
    raise exception 'Front start time cannot be in the future';
  end if;

  if p_ended_at is not null then
    if p_ended_at < p_started_at then
      raise exception 'Front end time cannot be before its start time';
    end if;
    if p_ended_at > v_now + interval '5 minutes' then
      raise exception 'Front end time cannot be in the future';
    end if;
  elsif exists (
    select 1
    from public.fronts other
    where other.user_id = p_user_id
      and other.id <> p_front_id
      and other.ended_at is null
  ) then
    raise exception 'Another front is already ongoing';
  end if;

  if p_note is not null and length(p_note) > 10000 then
    raise exception 'Front note is too long';
  end if;

  v_source := coalesce(nullif(pg_catalog.btrim(p_source),''), v_front.source);

  if length(v_source) > 32 then
    raise exception 'Front source is too long';
  end if;

  if v_source <> v_front.source and v_source <> 'nihility' then
    raise exception 'A history entry can only keep its origin or be detached to Nihility';
  end if;

  if v_front.source <> 'pluralkit' and v_source = 'pluralkit' then
    raise exception 'A local history entry cannot be converted into a PluralKit-linked entry';
  end if;

  if p_member_links is null or pg_catalog.jsonb_typeof(p_member_links) <> 'array' then
    raise exception 'Front member timing data is invalid';
  end if;

  if pg_catalog.jsonb_array_length(p_member_links) > 1000 then
    raise exception 'Too many members are attached to one front history entry';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_member_links) item
    where nullif(item->>'member_id','') is null
       or nullif(item->>'joined_at','') is null
  ) then
    raise exception 'Each selected member requires a join time';
  end if;

  if exists (
    select 1
    from (
      select (item->>'member_id')::uuid as member_id, count(*) as row_count
      from pg_catalog.jsonb_array_elements(p_member_links) item
      group by (item->>'member_id')::uuid
    ) duplicates
    where duplicates.row_count > 1
  ) then
    raise exception 'A member can only appear once in a front history entry';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_member_links) item
    where not exists (
      select 1
      from public.members m
      where m.id = (item->>'member_id')::uuid
        and m.user_id = p_user_id
    )
  ) then
    raise exception 'One or more selected members do not belong to this account';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_member_links) item
    where length(coalesce(item->>'note','')) > 4000
       or length(coalesce(item->>'private_note','')) > 4000
       or length(coalesce(item->>'mood','')) > 200
       or length(coalesce(item->>'context','')) > 1000
       or length(coalesce(item->>'activity','')) > 500
       or length(coalesce(item->>'location','')) > 500
  ) then
    raise exception 'One or more per-fronter detail fields exceed Nihility limits';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_member_links) item
    where (item->>'joined_at')::timestamptz < p_started_at
       or (p_ended_at is not null and (item->>'joined_at')::timestamptz > p_ended_at)
       or (item->>'joined_at')::timestamptz > v_now + interval '5 minutes'
  ) then
    raise exception 'A member join time falls outside the front';
  end if;

  if p_ended_at is null and exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_member_links) item
    where nullif(item->>'left_at','') is not null
  ) then
    raise exception 'Members in an active front cannot have a leave time';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_member_links) item
    where nullif(item->>'left_at','') is not null
      and (
        (item->>'left_at')::timestamptz < (item->>'joined_at')::timestamptz
        or (p_ended_at is not null and (item->>'left_at')::timestamptz > p_ended_at)
        or (item->>'left_at')::timestamptz > v_now + interval '5 minutes'
      )
  ) then
    raise exception 'A member leave time falls outside the front';
  end if;

  -- Existing history contains a small number of legitimate overlaps. Preserve
  -- them when needed, but never allow an edit to create a new overlap or widen
  -- an overlap beyond the range that already existed with the same entry.
  for v_other in
    select *
    from public.fronts
    where user_id = p_user_id
      and id <> p_front_id
  loop
    v_old_overlap :=
      pg_catalog.tstzrange(v_front.started_at, v_front.ended_at, '[)')
      * pg_catalog.tstzrange(v_other.started_at, v_other.ended_at, '[)');

    v_new_overlap :=
      pg_catalog.tstzrange(p_started_at, p_ended_at, '[)')
      * pg_catalog.tstzrange(v_other.started_at, v_other.ended_at, '[)');

    if not pg_catalog.isempty(v_old_overlap) then
      v_existing_overlaps := v_existing_overlaps + 1;
    end if;

    if not pg_catalog.isempty(v_new_overlap) then
      v_proposed_overlaps := v_proposed_overlaps + 1;
      if pg_catalog.isempty(v_old_overlap)
         or not (v_new_overlap <@ v_old_overlap) then
        raise exception 'This correction would create or widen an overlap with another front';
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'source', v_source,
    'existing_overlap_count', v_existing_overlaps,
    'proposed_overlap_count', v_proposed_overlaps
  );
end
$$;

revoke all on function private.validate_nihility_front_history_correction(
  uuid,uuid,timestamptz,timestamptz,text,text,jsonb
) from public, anon, authenticated;
grant execute on function private.validate_nihility_front_history_correction(
  uuid,uuid,timestamptz,timestamptz,text,text,jsonb
) to service_role;

create or replace function public.correct_nihility_front_history(
  p_user_id uuid,
  p_front_id uuid,
  p_expected_revision text,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_note text,
  p_source text,
  p_member_links jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_snapshot jsonb;
  v_validation jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':nihility-front-history', 0)
  );

  perform 1
  from public.fronts
  where user_id = p_user_id
    and id = p_front_id
  for update;

  if not found then
    raise exception 'Front history entry was not found';
  end if;

  v_snapshot := private.nihility_front_history_snapshot(p_user_id,p_front_id);

  if p_expected_revision is null
     or p_expected_revision <> v_snapshot->>'revision' then
    return jsonb_build_object(
      'error','This history entry changed since you opened it. Review the latest version before saving.',
      'stale',true
    );
  end if;

  begin
    v_validation := private.validate_nihility_front_history_correction(
      p_user_id,p_front_id,p_started_at,p_ended_at,p_note,p_source,p_member_links
    );
  exception when others then
    return jsonb_build_object('error',left(sqlerrm,500));
  end;

  -- Detaching an imported PluralKit record turns it into a purely local
  -- correction. Tombstone the original switch ID first so a later PK import
  -- cannot recreate the detached record as a duplicate.
  if v_snapshot->'front'->>'source' = 'pluralkit'
     and v_validation->>'source' = 'nihility'
     and nullif(v_snapshot->'front'->>'external_id','') is not null then
    insert into private.front_history_tombstones(
      user_id,provider,external_id,deleted_at
    )
    values(
      p_user_id,
      'pluralkit',
      v_snapshot->'front'->>'external_id',
      pg_catalog.clock_timestamp()
    )
    on conflict(user_id,provider,external_id)
    do update set deleted_at = excluded.deleted_at;
  end if;

  update public.fronts
  set started_at = p_started_at,
      ended_at = p_ended_at,
      note = nullif(p_note,''),
      source = v_validation->>'source',
      external_id = case
        when v_snapshot->'front'->>'source' = 'pluralkit'
         and v_validation->>'source' = 'nihility'
        then null
        else external_id
      end
  where user_id = p_user_id
    and id = p_front_id;

  delete from public.front_members
  where user_id = p_user_id
    and front_id = p_front_id;

  insert into public.front_members(
    user_id,front_id,member_id,joined_at,left_at,
    note,private_note,mood,context,activity,location
  )
  select
    p_user_id,
    p_front_id,
    (item->>'member_id')::uuid,
    (item->>'joined_at')::timestamptz,
    nullif(item->>'left_at','')::timestamptz,
    nullif(item->>'note',''),
    nullif(item->>'private_note',''),
    nullif(item->>'mood',''),
    nullif(item->>'context',''),
    nullif(item->>'activity',''),
    nullif(item->>'location','')
  from pg_catalog.jsonb_array_elements(p_member_links) item;

  return private.nihility_front_history_snapshot(p_user_id,p_front_id)
    || jsonb_build_object('validation',v_validation);
end
$$;

revoke all on function public.correct_nihility_front_history(
  uuid,uuid,text,timestamptz,timestamptz,text,text,jsonb
) from public, anon, authenticated;
grant execute on function public.correct_nihility_front_history(
  uuid,uuid,text,timestamptz,timestamptz,text,text,jsonb
) to service_role;

create or replace function public.log_front_detailed(
  p_member_details jsonb,
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
  effective_started_at timestamptz := coalesce(p_started_at, now());
  active_started_at timestamptz;
  v_item jsonb;
begin
  if uid is null then
    raise exception 'Authentication required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text || ':nihility-front-history', 0));
  if p_note is not null and length(p_note) > 10000 then raise exception 'Front note is too long'; end if;
  if p_member_details is null or pg_catalog.jsonb_typeof(p_member_details) <> 'array' then raise exception 'Front member details must be an array'; end if;
  if pg_catalog.jsonb_array_length(p_member_details) > 1000 then raise exception 'Too many members are attached to one front'; end if;
  if effective_started_at > now() + interval '5 minutes' then raise exception 'Front start time cannot be in the future'; end if;

  select started_at into active_started_at
  from public.fronts where user_id=uid and ended_at is null
  order by started_at desc limit 1;
  if active_started_at is not null and effective_started_at < active_started_at then
    raise exception 'Start time cannot be earlier than the current front';
  end if;

  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_member_details) j(value)
    where coalesce(j.value->>'member_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) then raise exception 'One or more selected members are invalid'; end if;

  if exists (
    select 1 from (
      select j.value->>'member_id' member_id,count(*) c
      from pg_catalog.jsonb_array_elements(p_member_details) j(value)
      group by j.value->>'member_id'
    ) d where d.c > 1
  ) then raise exception 'A member can only appear once in a front'; end if;

  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_member_details) j(value)
    where not exists (
      select 1 from public.members m
      where m.id=(j.value->>'member_id')::uuid and m.user_id=uid and m.archived_at is null
    )
  ) then raise exception 'One or more selected members are unavailable'; end if;

  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_member_details) j(value)
    where length(coalesce(j.value->>'note','')) > 4000
       or length(coalesce(j.value->>'private_note','')) > 4000
       or length(coalesce(j.value->>'mood','')) > 200
       or length(coalesce(j.value->>'context','')) > 1000
       or length(coalesce(j.value->>'activity','')) > 500
       or length(coalesce(j.value->>'location','')) > 500
  ) then raise exception 'One or more per-fronter detail fields exceed Nihility limits'; end if;

  update public.front_members fm
  set left_at=effective_started_at
  where fm.user_id=uid and fm.left_at is null
    and exists (
      select 1 from public.fronts f
      where f.id=fm.front_id and f.user_id=uid and f.ended_at is null
    );

  update public.fronts set ended_at=effective_started_at where user_id=uid and ended_at is null;

  insert into public.fronts(user_id,started_at,note,source)
  values(uid,effective_started_at,nullif(p_note,''),'nihility')
  returning id into new_front;

  for v_item in select value from pg_catalog.jsonb_array_elements(p_member_details)
  loop
    insert into public.front_members(
      user_id,front_id,member_id,joined_at,left_at,note,private_note,mood,context,activity,location
    ) values(
      uid,new_front,(v_item->>'member_id')::uuid,effective_started_at,null,
      nullif(v_item->>'note',''),nullif(v_item->>'private_note',''),nullif(v_item->>'mood',''),
      nullif(v_item->>'context',''),nullif(v_item->>'activity',''),nullif(v_item->>'location','')
    );
  end loop;
  return new_front;
end
$$;

revoke all on function public.log_front_detailed(jsonb,timestamptz,text) from public, anon;
grant execute on function public.log_front_detailed(jsonb,timestamptz,text) to authenticated, service_role;

create or replace function public.restore_nihility_backup(
  p_user_id uuid,
  p_backup jsonb,
  p_media_paths jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_data jsonb;
  v_members jsonb;
  v_groups jsonb;
  v_member_groups jsonb;
  v_fronts jsonb;
  v_front_members jsonb;
  v_imports jsonb;
  v_settings jsonb;
  v_system jsonb;
  v_profile jsonb;
  v_avatar_key text;
  v_banner_key text;
  v_avatar_path text;
  v_banner_path text;
begin
  if p_user_id is null then
    raise exception 'Backup owner is required';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.user_id = p_user_id
      and p.role = 'owner'
  ) then
    raise exception 'Only the Nihility owner can restore backups';
  end if;

  if jsonb_typeof(p_backup) <> 'object'
     or p_backup->>'format' <> 'project-nihility-backup'
     or coalesce((p_backup->>'version')::integer, 0) <> 1
     or jsonb_typeof(p_backup->'data') <> 'object' then
    raise exception 'Unsupported Nihility backup format';
  end if;

  if p_media_paths is null or jsonb_typeof(p_media_paths) <> 'object' then
    raise exception 'Invalid backup media map';
  end if;

  v_data := p_backup->'data';
  v_members := case when jsonb_typeof(v_data->'members') = 'array' then v_data->'members' else '[]'::jsonb end;
  v_groups := case when jsonb_typeof(v_data->'groups') = 'array' then v_data->'groups' else '[]'::jsonb end;
  v_member_groups := case when jsonb_typeof(v_data->'member_groups') = 'array' then v_data->'member_groups' else '[]'::jsonb end;
  v_fronts := case when jsonb_typeof(v_data->'fronts') = 'array' then v_data->'fronts' else '[]'::jsonb end;
  v_front_members := case when jsonb_typeof(v_data->'front_members') = 'array' then v_data->'front_members' else '[]'::jsonb end;
  v_imports := case when jsonb_typeof(v_data->'imports') = 'array' then v_data->'imports' else '[]'::jsonb end;

  if jsonb_array_length(v_members) > 10000
     or jsonb_array_length(v_groups) > 5000
     or jsonb_array_length(v_member_groups) > 100000
     or jsonb_array_length(v_fronts) > 200000
     or jsonb_array_length(v_front_members) > 500000
     or jsonb_array_length(v_imports) > 50000 then
    raise exception 'Backup exceeds Nihility account limits';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':nihility-backup-restore', 0)
  );

  create temporary table _nihility_restore_member_map(
    old_id text primary key,
    new_id uuid not null unique
  ) on commit drop;

  create temporary table _nihility_restore_group_map(
    old_id text primary key,
    new_id uuid not null unique
  ) on commit drop;

  create temporary table _nihility_restore_front_map(
    old_id text primary key,
    new_id uuid not null unique
  ) on commit drop;

  insert into _nihility_restore_member_map(old_id,new_id)
  select item->>'backup_id', gen_random_uuid()
  from jsonb_array_elements(v_members) item;

  insert into _nihility_restore_group_map(old_id,new_id)
  select item->>'backup_id', gen_random_uuid()
  from jsonb_array_elements(v_groups) item;

  insert into _nihility_restore_front_map(old_id,new_id)
  select item->>'backup_id', gen_random_uuid()
  from jsonb_array_elements(v_fronts) item;

  -- Delete only portable system data. Account identity, sessions, invitations,
  -- integration settings, and encrypted integration secrets are untouched.
  delete from public.front_members where user_id = p_user_id;
  delete from public.member_groups where user_id = p_user_id;
  delete from public.fronts where user_id = p_user_id;
  delete from public.members where user_id = p_user_id;
  delete from public.groups where user_id = p_user_id;
  delete from public.imports where user_id = p_user_id;
  delete from public.app_settings where user_id = p_user_id;

  insert into public.members(
    id,user_id,name,display_name,pronouns,color,description,birthday,
    avatar_url,avatar_source,banner_url,banner_source,
    pk_id,tupper_id,metadata,created_at,updated_at,
    avatar_storage_path,banner_storage_path,archived_at
  )
  select
    map.new_id,
    p_user_id,
    item->>'name',
    nullif(item->>'display_name',''),
    nullif(item->>'pronouns',''),
    nullif(item->>'color',''),
    nullif(item->>'description',''),
    nullif(item->>'birthday','')::date,
    case
      when coalesce(p_media_paths->>(item->>'avatar_media_key'),'') <> '' then null
      when item->>'avatar_source' = 'external' then nullif(item->>'avatar_url','')
      else null
    end,
    case
      when coalesce(p_media_paths->>(item->>'avatar_media_key'),'') <> '' then 'supabase'
      when item->>'avatar_source' = 'external' and nullif(item->>'avatar_url','') is not null then 'external'
      else null
    end,
    case
      when coalesce(p_media_paths->>(item->>'banner_media_key'),'') <> '' then null
      when item->>'banner_source' = 'external' then nullif(item->>'banner_url','')
      else null
    end,
    case
      when coalesce(p_media_paths->>(item->>'banner_media_key'),'') <> '' then 'supabase'
      when item->>'banner_source' = 'external' and nullif(item->>'banner_url','') is not null then 'external'
      else null
    end,
    nullif(item->>'pk_id',''),
    nullif(item->>'tupper_id',''),
    case when jsonb_typeof(item->'metadata') = 'object' then item->'metadata' else '{}'::jsonb end,
    coalesce(nullif(item->>'created_at','')::timestamptz, pg_catalog.now()),
    coalesce(nullif(item->>'updated_at','')::timestamptz, pg_catalog.now()),
    nullif(p_media_paths->>(item->>'avatar_media_key'),''),
    nullif(p_media_paths->>(item->>'banner_media_key'),''),
    nullif(item->>'archived_at','')::timestamptz
  from jsonb_array_elements(v_members) item
  join _nihility_restore_member_map map
    on map.old_id = item->>'backup_id';

  insert into public.groups(
    id,user_id,name,display_name,description,color,
    icon_url,icon_source,pk_id,tupper_id,metadata,
    created_at,updated_at,icon_storage_path
  )
  select
    map.new_id,
    p_user_id,
    item->>'name',
    nullif(item->>'display_name',''),
    nullif(item->>'description',''),
    nullif(item->>'color',''),
    case
      when coalesce(p_media_paths->>(item->>'icon_media_key'),'') <> '' then null
      when item->>'icon_source' = 'external' then nullif(item->>'icon_url','')
      else null
    end,
    case
      when coalesce(p_media_paths->>(item->>'icon_media_key'),'') <> '' then 'supabase'
      when item->>'icon_source' = 'external' and nullif(item->>'icon_url','') is not null then 'external'
      else null
    end,
    nullif(item->>'pk_id',''),
    nullif(item->>'tupper_id',''),
    jsonb_strip_nulls(
      (
        case when jsonb_typeof(item->'metadata') = 'object'
          then item->'metadata'
          else '{}'::jsonb
        end
        - 'icon_storage_path'
        - 'banner_storage_path'
      )
      || jsonb_build_object(
        'icon_storage_path', nullif(p_media_paths->>(item->>'icon_media_key'),''),
        'banner_storage_path', nullif(p_media_paths->>(item->>'banner_media_key'),'')
      )
    ),
    coalesce(nullif(item->>'created_at','')::timestamptz, pg_catalog.now()),
    coalesce(nullif(item->>'updated_at','')::timestamptz, pg_catalog.now()),
    nullif(p_media_paths->>(item->>'icon_media_key'),'')
  from jsonb_array_elements(v_groups) item
  join _nihility_restore_group_map map
    on map.old_id = item->>'backup_id';

  insert into public.member_groups(user_id,member_id,group_id,created_at)
  select
    p_user_id,
    member_map.new_id,
    group_map.new_id,
    coalesce(nullif(item->>'created_at','')::timestamptz, pg_catalog.now())
  from jsonb_array_elements(v_member_groups) item
  join _nihility_restore_member_map member_map
    on member_map.old_id = item->>'member_backup_id'
  join _nihility_restore_group_map group_map
    on group_map.old_id = item->>'group_backup_id';

  insert into public.fronts(
    id,user_id,started_at,ended_at,note,source,external_id,created_at
  )
  select
    map.new_id,
    p_user_id,
    nullif(item->>'started_at','')::timestamptz,
    nullif(item->>'ended_at','')::timestamptz,
    nullif(item->>'note',''),
    coalesce(nullif(item->>'source',''),'nihility'),
    nullif(item->>'external_id',''),
    coalesce(nullif(item->>'created_at','')::timestamptz, pg_catalog.now())
  from jsonb_array_elements(v_fronts) item
  join _nihility_restore_front_map map
    on map.old_id = item->>'backup_id';

  insert into public.front_members(
    user_id,front_id,member_id,joined_at,left_at,
    note,private_note,mood,context,activity,location
  )
  select
    p_user_id,
    front_map.new_id,
    member_map.new_id,
    nullif(item->>'joined_at','')::timestamptz,
    nullif(item->>'left_at','')::timestamptz,
    nullif(item->>'note',''),
    nullif(item->>'private_note',''),
    nullif(item->>'mood',''),
    nullif(item->>'context',''),
    nullif(item->>'activity',''),
    nullif(item->>'location','')
  from jsonb_array_elements(v_front_members) item
  join _nihility_restore_front_map front_map
    on front_map.old_id = item->>'front_backup_id'
  join _nihility_restore_member_map member_map
    on member_map.old_id = item->>'member_backup_id';

  v_settings := case
    when jsonb_typeof(v_data->'settings') = 'object' then v_data->'settings'
    else '{}'::jsonb
  end;

  if jsonb_typeof(v_settings->'system_profile') = 'object' then
    v_system := v_settings->'system_profile';
    v_avatar_key := nullif(v_system->>'avatar_media_key','');
    v_banner_key := nullif(v_system->>'banner_media_key','');
    v_avatar_path := case when v_avatar_key is null then null else nullif(p_media_paths->>v_avatar_key,'') end;
    v_banner_path := case when v_banner_key is null then null else nullif(p_media_paths->>v_banner_key,'') end;

    v_system := v_system
      - 'avatar_storage_path'
      - 'banner_storage_path'
      - 'avatar_media_key'
      - 'banner_media_key';

    if v_avatar_path is not null then
      v_system := v_system || jsonb_build_object('avatar_url',null,'avatar_storage_path',v_avatar_path);
    end if;
    if v_banner_path is not null then
      v_system := v_system || jsonb_build_object('banner_url',null,'banner_storage_path',v_banner_path);
    end if;

    v_settings := jsonb_set(v_settings,'{system_profile}',v_system,true);
  end if;

  insert into public.app_settings(user_id,settings,updated_at)
  values(p_user_id,v_settings,pg_catalog.now());

  insert into public.imports(id,user_id,source,summary,created_at)
  select
    gen_random_uuid(),
    p_user_id,
    item->>'source',
    case when jsonb_typeof(item->'summary') = 'object' then item->'summary' else '{}'::jsonb end,
    coalesce(nullif(item->>'created_at','')::timestamptz, pg_catalog.now())
  from jsonb_array_elements(v_imports) item;

  v_profile := case
    when jsonb_typeof(v_data->'profile') = 'object' then v_data->'profile'
    else '{}'::jsonb
  end;
  v_avatar_key := nullif(v_profile->>'avatar_media_key','');
  v_banner_key := nullif(v_profile->>'banner_media_key','');
  v_avatar_path := case when v_avatar_key is null then null else nullif(p_media_paths->>v_avatar_key,'') end;
  v_banner_path := case when v_banner_key is null then null else nullif(p_media_paths->>v_banner_key,'') end;

  update public.profiles
  set display_name = nullif(v_profile->>'display_name',''),
      avatar_url = case when v_avatar_path is null then nullif(v_profile->>'avatar_url','') else null end,
      avatar_storage_path = v_avatar_path,
      banner_url = case when v_banner_path is null then nullif(v_profile->>'banner_url','') else null end,
      banner_storage_path = v_banner_path,
      updated_at = pg_catalog.now()
  where user_id = p_user_id;

  return jsonb_build_object(
    'restored', true,
    'members', jsonb_array_length(v_members),
    'groups', jsonb_array_length(v_groups),
    'member_groups', jsonb_array_length(v_member_groups),
    'fronts', jsonb_array_length(v_fronts),
    'front_members', jsonb_array_length(v_front_members),
    'imports', jsonb_array_length(v_imports),
    'media_paths', jsonb_object_length(p_media_paths)
  );
end
$$;

revoke all on function public.restore_nihility_backup(uuid,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.restore_nihility_backup(uuid,jsonb,jsonb)
  to service_role;
