-- Safe, atomic front-history correction primitives.
-- History changes are performed only by the authenticated nihility-secure Edge
-- Function using service_role. Browser clients cannot execute these helpers.

create table if not exists private.front_history_tombstones (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  external_id text not null,
  deleted_at timestamptz not null default now(),
  primary key (user_id, provider, external_id),
  check (length(provider) between 1 and 32),
  check (length(external_id) between 1 and 128)
);

revoke all on table private.front_history_tombstones
  from public, anon, authenticated;
grant select, insert, delete on table private.front_history_tombstones
  to service_role;

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
          'left_at', fm.left_at
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

create or replace function public.preview_nihility_front_history_correction(
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
  v_snapshot jsonb;
  v_validation jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':nihility-front-history', 0)
  );

  v_snapshot := private.nihility_front_history_snapshot(p_user_id,p_front_id);
  if v_snapshot is null then
    raise exception 'Front history entry was not found';
  end if;

  v_validation := private.validate_nihility_front_history_correction(
    p_user_id,p_front_id,p_started_at,p_ended_at,p_note,p_source,p_member_links
  );

  return v_snapshot || jsonb_build_object('validation',v_validation);
end
$$;

revoke all on function public.preview_nihility_front_history_correction(
  uuid,uuid,timestamptz,timestamptz,text,text,jsonb
) from public, anon, authenticated;
grant execute on function public.preview_nihility_front_history_correction(
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
    raise exception 'This history entry changed since you opened it. Review the latest version before saving.';
  end if;

  v_validation := private.validate_nihility_front_history_correction(
    p_user_id,p_front_id,p_started_at,p_ended_at,p_note,p_source,p_member_links
  );

  update public.fronts
  set started_at = p_started_at,
      ended_at = p_ended_at,
      note = nullif(p_note,''),
      source = v_validation->>'source'
  where user_id = p_user_id
    and id = p_front_id;

  delete from public.front_members
  where user_id = p_user_id
    and front_id = p_front_id;

  insert into public.front_members(
    user_id,front_id,member_id,joined_at,left_at
  )
  select
    p_user_id,
    p_front_id,
    (item->>'member_id')::uuid,
    (item->>'joined_at')::timestamptz,
    nullif(item->>'left_at','')::timestamptz
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

create or replace function public.delete_nihility_front_history(
  p_user_id uuid,
  p_front_id uuid,
  p_expected_revision text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_front public.fronts%rowtype;
  v_snapshot jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':nihility-front-history', 0)
  );

  select *
  into v_front
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
    raise exception 'This history entry changed since you opened it. Review the latest version before deleting it.';
  end if;

  -- Imported PK entries keep a private deletion tombstone so a later history
  -- import does not silently resurrect a record the user explicitly removed.
  if v_front.external_id is not null
     and v_front.source in ('pluralkit','nihility') then
    insert into private.front_history_tombstones(
      user_id,provider,external_id,deleted_at
    )
    values(
      p_user_id,'pluralkit',v_front.external_id,pg_catalog.clock_timestamp()
    )
    on conflict(user_id,provider,external_id)
    do update set deleted_at = excluded.deleted_at;
  end if;

  delete from public.fronts
  where user_id = p_user_id
    and id = p_front_id;

  return jsonb_build_object(
    'deleted', true,
    'front_id', p_front_id,
    'tombstoned', v_front.external_id is not null
  );
end
$$;

revoke all on function public.delete_nihility_front_history(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.delete_nihility_front_history(uuid,uuid,text)
  to service_role;

create or replace function public.nihility_front_history_tombstones(
  p_user_id uuid,
  p_provider text,
  p_external_ids text[]
)
returns text[]
language sql
security invoker
set search_path = ''
as $$
  select coalesce(pg_catalog.array_agg(t.external_id), array[]::text[])
  from private.front_history_tombstones t
  where t.user_id = p_user_id
    and t.provider = p_provider
    and t.external_id = any(coalesce(p_external_ids,array[]::text[]))
$$;

revoke all on function public.nihility_front_history_tombstones(uuid,text,text[])
  from public, anon, authenticated;
grant execute on function public.nihility_front_history_tombstones(uuid,text,text[])
  to service_role;

-- Serialize normal front changes with history corrections for the same account.
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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(uid::text || ':nihility-front-history', 0)
  );

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
