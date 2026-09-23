-- Secure, service-only backup restore.
-- Restores only user-owned Nihility data. It never changes auth identity, role,
-- invites, integration credentials, Vault secrets, or security logs.

create or replace function public.restore_nihility_backup(
  p_user_id uuid,
  p_backup jsonb,
  p_mode text default 'merge'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  members_inserted integer := 0;
  groups_inserted integer := 0;
  member_groups_inserted integer := 0;
  fronts_inserted integer := 0;
  front_members_inserted integer := 0;
  imports_inserted integer := 0;
  settings_inserted integer := 0;
begin
  if p_user_id is null or not exists (
    select 1 from public.profiles p where p.user_id = p_user_id
  ) then
    raise exception 'Nihility profile required';
  end if;

  if p_mode not in ('merge','replace') then
    raise exception 'Invalid restore mode';
  end if;

  if p_backup is null
     or p_backup->>'format' <> 'project-nihility-backup'
     or coalesce((p_backup->>'version')::integer,0) <> 1 then
    raise exception 'Unsupported Nihility backup';
  end if;

  if octet_length(p_backup::text) > 26214400 then
    raise exception 'Backup is too large';
  end if;

  if jsonb_typeof(p_backup#>'{data,members}') <> 'array'
     or jsonb_typeof(p_backup#>'{data,groups}') <> 'array'
     or jsonb_typeof(p_backup#>'{data,member_groups}') <> 'array'
     or jsonb_typeof(p_backup#>'{data,fronts}') <> 'array'
     or jsonb_typeof(p_backup#>'{data,front_members}') <> 'array'
     or jsonb_typeof(p_backup#>'{data,imports}') <> 'array' then
    raise exception 'Backup data is malformed';
  end if;

  if jsonb_array_length(p_backup#>'{data,members}') > 10000
     or jsonb_array_length(p_backup#>'{data,groups}') > 5000
     or jsonb_array_length(p_backup#>'{data,member_groups}') > 100000
     or jsonb_array_length(p_backup#>'{data,fronts}') > 200000
     or jsonb_array_length(p_backup#>'{data,front_members}') > 500000
     or jsonb_array_length(p_backup#>'{data,imports}') > 50000 then
    raise exception 'Backup exceeds Nihility account limits';
  end if;

  -- A backup may never claim a primary key already owned by another account.
  if exists (
    select 1
    from jsonb_array_elements(p_backup#>'{data,members}') j
    join public.members m on m.id=(j->>'id')::uuid
    where m.user_id<>p_user_id
  ) then raise exception 'Backup contains a conflicting member identifier'; end if;

  if exists (
    select 1
    from jsonb_array_elements(p_backup#>'{data,groups}') j
    join public.groups g on g.id=(j->>'id')::uuid
    where g.user_id<>p_user_id
  ) then raise exception 'Backup contains a conflicting group identifier'; end if;

  if exists (
    select 1
    from jsonb_array_elements(p_backup#>'{data,fronts}') j
    join public.fronts f on f.id=(j->>'id')::uuid
    where f.user_id<>p_user_id
  ) then raise exception 'Backup contains a conflicting front identifier'; end if;

  if exists (
    select 1
    from jsonb_array_elements(p_backup#>'{data,imports}') j
    join public.imports i on i.id=(j->>'id')::uuid
    where i.user_id<>p_user_id
  ) then raise exception 'Backup contains a conflicting import identifier'; end if;

  if p_mode='replace' then
    delete from public.front_members where user_id=p_user_id;
    delete from public.member_groups where user_id=p_user_id;
    delete from public.fronts where user_id=p_user_id;
    delete from public.groups where user_id=p_user_id;
    delete from public.members where user_id=p_user_id;
    delete from public.imports where user_id=p_user_id;
    delete from public.app_settings where user_id=p_user_id;
  end if;

  insert into public.members(
    id,user_id,name,display_name,pronouns,color,description,birthday,
    avatar_url,avatar_source,banner_url,banner_source,pk_id,tupper_id,metadata,
    created_at,updated_at,avatar_storage_path,banner_storage_path,archived_at
  )
  select
    x.id,p_user_id,x.name,x.display_name,x.pronouns,x.color,x.description,x.birthday,
    null,case when x.avatar_storage_path is not null then 'supabase' else null end,
    null,case when x.banner_storage_path is not null then 'supabase' else null end,
    x.pk_id,x.tupper_id,coalesce(x.metadata,'{}'::jsonb),
    coalesce(x.created_at,now()),coalesce(x.updated_at,now()),
    x.avatar_storage_path,x.banner_storage_path,x.archived_at
  from jsonb_to_recordset(p_backup#>'{data,members}') as x(
    id uuid,name text,display_name text,pronouns text,color text,description text,birthday date,
    pk_id text,tupper_id text,metadata jsonb,created_at timestamptz,updated_at timestamptz,
    avatar_storage_path text,banner_storage_path text,archived_at timestamptz
  )
  on conflict do nothing;
  get diagnostics members_inserted = row_count;

  insert into public.groups(
    id,user_id,name,display_name,description,color,icon_url,icon_source,pk_id,tupper_id,
    metadata,created_at,updated_at,icon_storage_path
  )
  select
    x.id,p_user_id,x.name,x.display_name,x.description,x.color,
    null,case when x.icon_storage_path is not null then 'supabase' else null end,
    x.pk_id,x.tupper_id,coalesce(x.metadata,'{}'::jsonb),
    coalesce(x.created_at,now()),coalesce(x.updated_at,now()),x.icon_storage_path
  from jsonb_to_recordset(p_backup#>'{data,groups}') as x(
    id uuid,name text,display_name text,description text,color text,pk_id text,tupper_id text,
    metadata jsonb,created_at timestamptz,updated_at timestamptz,icon_storage_path text
  )
  on conflict do nothing;
  get diagnostics groups_inserted = row_count;

  insert into public.member_groups(user_id,member_id,group_id,created_at)
  select p_user_id,x.member_id,x.group_id,coalesce(x.created_at,now())
  from jsonb_to_recordset(p_backup#>'{data,member_groups}') as x(
    member_id uuid,group_id uuid,created_at timestamptz
  )
  on conflict do nothing;
  get diagnostics member_groups_inserted = row_count;

  insert into public.fronts(id,user_id,started_at,ended_at,note,source,external_id,created_at)
  select
    x.id,p_user_id,x.started_at,x.ended_at,x.note,coalesce(x.source,'nihility'),x.external_id,
    coalesce(x.created_at,now())
  from jsonb_to_recordset(p_backup#>'{data,fronts}') as x(
    id uuid,started_at timestamptz,ended_at timestamptz,note text,source text,
    external_id text,created_at timestamptz
  )
  on conflict do nothing;
  get diagnostics fronts_inserted = row_count;

  insert into public.front_members(user_id,front_id,member_id,joined_at,left_at)
  select p_user_id,x.front_id,x.member_id,x.joined_at,x.left_at
  from jsonb_to_recordset(p_backup#>'{data,front_members}') as x(
    front_id uuid,member_id uuid,joined_at timestamptz,left_at timestamptz
  )
  on conflict do nothing;
  get diagnostics front_members_inserted = row_count;

  insert into public.imports(id,user_id,source,summary,created_at)
  select x.id,p_user_id,x.source,coalesce(x.summary,'{}'::jsonb),coalesce(x.created_at,now())
  from jsonb_to_recordset(p_backup#>'{data,imports}') as x(
    id uuid,source text,summary jsonb,created_at timestamptz
  )
  on conflict do nothing;
  get diagnostics imports_inserted = row_count;

  if jsonb_typeof(p_backup#>'{data,app_settings}')='object' then
    if p_mode='replace' then
      insert into public.app_settings(user_id,settings,updated_at)
      values(
        p_user_id,
        coalesce(p_backup#>'{data,app_settings,settings}','{}'::jsonb),
        coalesce((p_backup#>>'{data,app_settings,updated_at}')::timestamptz,now())
      )
      on conflict (user_id) do update
        set settings=excluded.settings,updated_at=excluded.updated_at;
      settings_inserted := 1;
    else
      insert into public.app_settings(user_id,settings,updated_at)
      values(
        p_user_id,
        coalesce(p_backup#>'{data,app_settings,settings}','{}'::jsonb),
        coalesce((p_backup#>>'{data,app_settings,updated_at}')::timestamptz,now())
      )
      on conflict (user_id) do nothing;
      get diagnostics settings_inserted = row_count;
    end if;
  end if;

  if p_mode='replace' and jsonb_typeof(p_backup->'profile')='object' then
    update public.profiles
    set
      display_name=coalesce(nullif(p_backup#>>'{profile,display_name}',''),display_name),
      avatar_url=null,
      avatar_storage_path=nullif(p_backup#>>'{profile,avatar_storage_path}',''),
      banner_url=null,
      banner_storage_path=nullif(p_backup#>>'{profile,banner_storage_path}',''),
      updated_at=now()
    where user_id=p_user_id;
  end if;

  return jsonb_build_object(
    'mode',p_mode,
    'members_inserted',members_inserted,
    'groups_inserted',groups_inserted,
    'member_groups_inserted',member_groups_inserted,
    'fronts_inserted',fronts_inserted,
    'front_members_inserted',front_members_inserted,
    'imports_inserted',imports_inserted,
    'settings_inserted',settings_inserted
  );
end;
$$;

revoke all on function public.restore_nihility_backup(uuid,jsonb,text)
  from public, anon, authenticated;
grant execute on function public.restore_nihility_backup(uuid,jsonb,text)
  to service_role;
