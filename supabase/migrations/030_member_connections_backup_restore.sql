-- Include member connections in backup counts and replacement restore.

-- Backup/restore support for structured member fields and tags.

create or replace function public.nihility_backup_counts(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path=''
as $$
  select case
    when exists(select 1 from public.profiles p where p.user_id=p_user_id and p.role='owner')
    then jsonb_build_object(
      'members',(select count(*) from public.members where user_id=p_user_id),
      'groups',(select count(*) from public.groups where user_id=p_user_id),
      'member_groups',(select count(*) from public.member_groups where user_id=p_user_id),
      'fronts',(select count(*) from public.fronts where user_id=p_user_id),
      'front_members',(select count(*) from public.front_members where user_id=p_user_id),
      'imports',(select count(*) from public.imports where user_id=p_user_id),
      'member_field_definitions',(select count(*) from public.member_field_definitions where user_id=p_user_id),
      'member_field_values',(select count(*) from public.member_field_values where user_id=p_user_id),
      'member_tags',(select count(*) from public.member_tags where user_id=p_user_id),
      'member_tag_links',(select count(*) from public.member_tag_links where user_id=p_user_id),
      'member_connections',(select count(*) from public.member_connections where user_id=p_user_id)
    )
    else null
  end
$$;
revoke all on function public.nihility_backup_counts(uuid) from public,anon,authenticated;
grant execute on function public.nihility_backup_counts(uuid) to service_role;


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
  v_field_definitions jsonb;
  v_field_values jsonb;
  v_tags jsonb;
  v_tag_links jsonb;
  v_connections jsonb;
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
  v_field_definitions := case when jsonb_typeof(v_data->'member_field_definitions')='array' then v_data->'member_field_definitions' else '[]'::jsonb end;
  v_field_values := case when jsonb_typeof(v_data->'member_field_values')='array' then v_data->'member_field_values' else '[]'::jsonb end;
  v_tags := case when jsonb_typeof(v_data->'member_tags')='array' then v_data->'member_tags' else '[]'::jsonb end;
  v_tag_links := case when jsonb_typeof(v_data->'member_tag_links')='array' then v_data->'member_tag_links' else '[]'::jsonb end;
  v_connections := case when jsonb_typeof(v_data->'member_connections')='array' then v_data->'member_connections' else '[]'::jsonb end;

  if jsonb_array_length(v_members) > 10000
     or jsonb_array_length(v_groups) > 5000
     or jsonb_array_length(v_member_groups) > 100000
     or jsonb_array_length(v_fronts) > 200000
     or jsonb_array_length(v_front_members) > 500000
     or jsonb_array_length(v_imports) > 50000
     or jsonb_array_length(v_field_definitions) > 64
     or jsonb_array_length(v_field_values) > 640000
     or jsonb_array_length(v_tags) > 500
     or jsonb_array_length(v_tag_links) > 1000000
     or jsonb_array_length(v_connections) > 10000 then
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

  create temporary table _nihility_restore_field_map(
    old_id text primary key,
    new_id uuid not null unique
  ) on commit drop;

  create temporary table _nihility_restore_tag_map(
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

  insert into _nihility_restore_field_map(old_id,new_id)
  select item->>'backup_id', gen_random_uuid()
  from jsonb_array_elements(v_field_definitions) item;

  insert into _nihility_restore_tag_map(old_id,new_id)
  select item->>'backup_id', gen_random_uuid()
  from jsonb_array_elements(v_tags) item;

  -- Delete only portable system data. Account identity, sessions, invitations,
  -- integration settings, and encrypted integration secrets are untouched.
  delete from public.member_connections where user_id = p_user_id;
  delete from public.member_field_values where user_id = p_user_id;
  delete from public.member_tag_links where user_id = p_user_id;
  delete from public.member_field_definitions where user_id = p_user_id;
  delete from public.member_tags where user_id = p_user_id;
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

  insert into public.member_field_definitions(
    id,user_id,key,label,description,field_type,options,position,created_at,updated_at
  )
  select
    map.new_id,p_user_id,item->>'key',item->>'label',nullif(item->>'description',''),
    item->>'field_type',
    case when jsonb_typeof(item->'options')='array' then item->'options' else '[]'::jsonb end,
    coalesce((item->>'position')::integer,0),
    coalesce(nullif(item->>'created_at','')::timestamptz,pg_catalog.now()),
    coalesce(nullif(item->>'updated_at','')::timestamptz,pg_catalog.now())
  from jsonb_array_elements(v_field_definitions) item
  join _nihility_restore_field_map map on map.old_id=item->>'backup_id';

  insert into public.member_tags(id,user_id,name,color,created_at,updated_at)
  select
    map.new_id,p_user_id,item->>'name',nullif(item->>'color',''),
    coalesce(nullif(item->>'created_at','')::timestamptz,pg_catalog.now()),
    coalesce(nullif(item->>'updated_at','')::timestamptz,pg_catalog.now())
  from jsonb_array_elements(v_tags) item
  join _nihility_restore_tag_map map on map.old_id=item->>'backup_id';

  insert into public.member_field_values(user_id,member_id,field_id,value,created_at,updated_at)
  select
    p_user_id,member_map.new_id,field_map.new_id,item->'value',
    coalesce(nullif(item->>'created_at','')::timestamptz,pg_catalog.now()),
    coalesce(nullif(item->>'updated_at','')::timestamptz,pg_catalog.now())
  from jsonb_array_elements(v_field_values) item
  join _nihility_restore_member_map member_map on member_map.old_id=item->>'member_backup_id'
  join _nihility_restore_field_map field_map on field_map.old_id=item->>'field_backup_id';

  insert into public.member_tag_links(user_id,member_id,tag_id,created_at)
  select
    p_user_id,member_map.new_id,tag_map.new_id,
    coalesce(nullif(item->>'created_at','')::timestamptz,pg_catalog.now())
  from jsonb_array_elements(v_tag_links) item
  join _nihility_restore_member_map member_map on member_map.old_id=item->>'member_backup_id'
  join _nihility_restore_tag_map tag_map on tag_map.old_id=item->>'tag_backup_id';

  insert into public.member_connections(
    id,user_id,source_member_id,target_member_id,source_label,target_label,created_at,updated_at
  )
  select
    gen_random_uuid(),
    p_user_id,
    source_map.new_id,
    target_map.new_id,
    item->>'source_label',
    item->>'target_label',
    coalesce(nullif(item->>'created_at','')::timestamptz,pg_catalog.now()),
    coalesce(nullif(item->>'updated_at','')::timestamptz,pg_catalog.now())
  from jsonb_array_elements(v_connections) item
  join _nihility_restore_member_map source_map on source_map.old_id=item->>'source_member_backup_id'
  join _nihility_restore_member_map target_map on target_map.old_id=item->>'target_member_backup_id';

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
    'member_field_definitions', jsonb_array_length(v_field_definitions),
    'member_field_values', jsonb_array_length(v_field_values),
    'member_tags', jsonb_array_length(v_tags),
    'member_tag_links', jsonb_array_length(v_tag_links),
    'member_connections', jsonb_array_length(v_connections),
    'media_paths', (select count(*) from pg_catalog.jsonb_object_keys(p_media_paths))
  );
end
$$;

revoke all on function public.restore_nihility_backup(uuid,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.restore_nihility_backup(uuid,jsonb,jsonb)
  to service_role;
