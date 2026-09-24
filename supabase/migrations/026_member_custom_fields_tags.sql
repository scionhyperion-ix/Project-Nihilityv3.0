-- Structured member custom fields and searchable tags.

create table if not exists public.member_field_definitions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  label text not null,
  description text,
  field_type text not null,
  options jsonb not null default '[]'::jsonb,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_field_definitions_id_user_unique unique(id,user_id),
  constraint member_field_definitions_key_format check (key ~ '^[a-z][a-z0-9_]{0,31}$'),
  constraint member_field_definitions_label_length check (length(label) between 1 and 80),
  constraint member_field_definitions_description_length check (description is null or length(description) <= 240),
  constraint member_field_definitions_type_check check (field_type in ('text','long_text','number','boolean','date','select','multi_select')),
  constraint member_field_definitions_options_array check (jsonb_typeof(options)='array' and jsonb_array_length(options) <= 100),
  constraint member_field_definitions_position_check check (position between 0 and 10000)
);

create unique index if not exists member_field_definitions_user_key_unique
  on public.member_field_definitions(user_id,key);
create index if not exists member_field_definitions_user_position_idx
  on public.member_field_definitions(user_id,position,id);

create table if not exists public.member_field_values (
  user_id uuid not null references auth.users(id) on delete cascade,
  member_id uuid not null,
  field_id uuid not null,
  value jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(member_id,field_id),
  constraint member_field_values_member_owner_fkey
    foreign key(member_id,user_id) references public.members(id,user_id) on delete cascade,
  constraint member_field_values_field_owner_fkey
    foreign key(field_id,user_id) references public.member_field_definitions(id,user_id) on delete cascade
);
create index if not exists member_field_values_user_idx on public.member_field_values(user_id);
create index if not exists member_field_values_field_idx on public.member_field_values(field_id);

create table if not exists public.member_tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_tags_id_user_unique unique(id,user_id),
  constraint member_tags_name_length check (length(name) between 1 and 60),
  constraint member_tags_color_check check (color is null or color ~ '^[0-9A-Fa-f]{6}$')
);
create unique index if not exists member_tags_user_name_unique
  on public.member_tags(user_id,lower(name));
create index if not exists member_tags_user_name_idx
  on public.member_tags(user_id,lower(name));

create table if not exists public.member_tag_links (
  user_id uuid not null references auth.users(id) on delete cascade,
  member_id uuid not null,
  tag_id uuid not null,
  created_at timestamptz not null default now(),
  primary key(member_id,tag_id),
  constraint member_tag_links_member_owner_fkey
    foreign key(member_id,user_id) references public.members(id,user_id) on delete cascade,
  constraint member_tag_links_tag_owner_fkey
    foreign key(tag_id,user_id) references public.member_tags(id,user_id) on delete cascade
);
create index if not exists member_tag_links_user_idx on public.member_tag_links(user_id);
create index if not exists member_tag_links_tag_idx on public.member_tag_links(tag_id);

create or replace function private.validate_member_field_definition()
returns trigger
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_item jsonb;
  v_seen text[] := array[]::text[];
  v_text text;
begin
  new.key := lower(btrim(new.key));
  new.label := btrim(new.label);
  new.description := nullif(btrim(coalesce(new.description,'')),'');
  if new.field_type not in ('select','multi_select') then
    new.options := '[]'::jsonb;
  else
    if jsonb_typeof(new.options) <> 'array' or jsonb_array_length(new.options) > 100 then
      raise exception 'Select field options must be an array of at most 100 values';
    end if;
    for v_item in select value from jsonb_array_elements(new.options)
    loop
      if jsonb_typeof(v_item) <> 'string' then
        raise exception 'Select field options must be text';
      end if;
      v_text := btrim(v_item #>> '{}');
      if length(v_text) < 1 or length(v_text) > 100 then
        raise exception 'Each select option must be between 1 and 100 characters';
      end if;
      if lower(v_text) = any(v_seen) then
        raise exception 'Select field options must be unique';
      end if;
      v_seen := array_append(v_seen,lower(v_text));
    end loop;
  end if;

  if tg_op='INSERT' and (
    select count(*) from public.member_field_definitions d where d.user_id=new.user_id
  ) >= 64 then
    raise exception 'Nihility supports up to 64 custom member fields per account';
  end if;
  return new;
end
$$;
revoke all on function private.validate_member_field_definition() from public,anon,authenticated;

drop trigger if exists member_field_definitions_validate on public.member_field_definitions;
create trigger member_field_definitions_validate
before insert or update on public.member_field_definitions
for each row execute function private.validate_member_field_definition();

drop trigger if exists member_field_definitions_set_updated_at on public.member_field_definitions;
create trigger member_field_definitions_set_updated_at
before update on public.member_field_definitions
for each row execute function public.set_updated_at();

create or replace function private.validate_member_field_value()
returns trigger
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_def public.member_field_definitions%rowtype;
  v_type text;
  v_text text;
  v_item jsonb;
  v_seen text[] := array[]::text[];
begin
  select * into v_def
  from public.member_field_definitions
  where id=new.field_id and user_id=new.user_id;

  if not found then
    raise exception 'Custom field does not belong to this account';
  end if;

  v_type := jsonb_typeof(new.value);
  if v_def.field_type='text' then
    if v_type <> 'string' or length(new.value #>> '{}') > 500 then
      raise exception 'Text custom field value is invalid or too long';
    end if;
  elsif v_def.field_type='long_text' then
    if v_type <> 'string' or length(new.value #>> '{}') > 4000 then
      raise exception 'Long-text custom field value is invalid or too long';
    end if;
  elsif v_def.field_type='number' then
    if v_type <> 'number' or abs((new.value #>> '{}')::numeric) > 1000000000000000 then
      raise exception 'Number custom field value is invalid or outside Nihility limits';
    end if;
  elsif v_def.field_type='boolean' then
    if v_type <> 'boolean' then raise exception 'Yes/No custom field value is invalid'; end if;
  elsif v_def.field_type='date' then
    if v_type <> 'string'
       or (new.value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$'
       or to_char((new.value #>> '{}')::date,'YYYY-MM-DD') <> (new.value #>> '{}') then
      raise exception 'Date custom field value is invalid';
    end if;
  elsif v_def.field_type='select' then
    if v_type <> 'string' then raise exception 'Select custom field value is invalid'; end if;
    v_text := new.value #>> '{}';
    if not exists (
      select 1 from jsonb_array_elements_text(v_def.options) option_value
      where option_value=v_text
    ) then
      raise exception 'Select custom field value is not one of the configured options';
    end if;
  elsif v_def.field_type='multi_select' then
    if v_type <> 'array' or jsonb_array_length(new.value) > 50 then
      raise exception 'Multi-select custom field value is invalid or too large';
    end if;
    for v_item in select value from jsonb_array_elements(new.value)
    loop
      if jsonb_typeof(v_item) <> 'string' then
        raise exception 'Multi-select custom field choices must be text';
      end if;
      v_text := v_item #>> '{}';
      if not exists (
        select 1 from jsonb_array_elements_text(v_def.options) option_value
        where option_value=v_text
      ) then
        raise exception 'Multi-select custom field contains an unknown option';
      end if;
      if v_text = any(v_seen) then
        raise exception 'Multi-select custom field contains duplicate choices';
      end if;
      v_seen := array_append(v_seen,v_text);
    end loop;
  else
    raise exception 'Unsupported custom field type';
  end if;
  return new;
exception
  when invalid_datetime_format or datetime_field_overflow then
    raise exception 'Date custom field value is invalid';
end
$$;
revoke all on function private.validate_member_field_value() from public,anon,authenticated;

drop trigger if exists member_field_values_validate on public.member_field_values;
create trigger member_field_values_validate
before insert or update on public.member_field_values
for each row execute function private.validate_member_field_value();

drop trigger if exists member_field_values_set_updated_at on public.member_field_values;
create trigger member_field_values_set_updated_at
before update on public.member_field_values
for each row execute function public.set_updated_at();

create or replace function private.validate_member_tag()
returns trigger
language plpgsql
security invoker
set search_path=''
as $$
begin
  new.name := btrim(new.name);
  if tg_op='INSERT' and (
    select count(*) from public.member_tags t where t.user_id=new.user_id
  ) >= 500 then
    raise exception 'Nihility supports up to 500 tags per account';
  end if;
  return new;
end
$$;
revoke all on function private.validate_member_tag() from public,anon,authenticated;

drop trigger if exists member_tags_validate on public.member_tags;
create trigger member_tags_validate
before insert or update on public.member_tags
for each row execute function private.validate_member_tag();

drop trigger if exists member_tags_set_updated_at on public.member_tags;
create trigger member_tags_set_updated_at
before update on public.member_tags
for each row execute function public.set_updated_at();

alter table public.member_field_definitions enable row level security;
alter table public.member_field_values enable row level security;
alter table public.member_tags enable row level security;
alter table public.member_tag_links enable row level security;

drop policy if exists member_field_definitions_read_own on public.member_field_definitions;
create policy member_field_definitions_read_own
on public.member_field_definitions for select to authenticated
using (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()))
);

drop policy if exists member_field_definitions_owner_write on public.member_field_definitions;
create policy member_field_definitions_owner_write
on public.member_field_definitions for all to authenticated
using (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()) and p.role='owner')
)
with check (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()) and p.role='owner')
);

drop policy if exists member_field_values_own on public.member_field_values;
create policy member_field_values_own
on public.member_field_values for all to authenticated
using (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()))
)
with check (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()))
);

drop policy if exists member_tags_read_own on public.member_tags;
create policy member_tags_read_own
on public.member_tags for select to authenticated
using (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()))
);

drop policy if exists member_tags_owner_write on public.member_tags;
create policy member_tags_owner_write
on public.member_tags for all to authenticated
using (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()) and p.role='owner')
)
with check (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()) and p.role='owner')
);

drop policy if exists member_tag_links_own on public.member_tag_links;
create policy member_tag_links_own
on public.member_tag_links for all to authenticated
using (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()))
)
with check (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()))
);

revoke all on public.member_field_definitions from anon,authenticated;
revoke all on public.member_field_values from anon,authenticated;
revoke all on public.member_tags from anon,authenticated;
revoke all on public.member_tag_links from anon,authenticated;

grant select,insert,update,delete on public.member_field_definitions to authenticated;
grant select,insert,update,delete on public.member_field_values to authenticated;
grant select,insert,update,delete on public.member_tags to authenticated;
grant select,insert,update,delete on public.member_tag_links to authenticated;

create or replace function public.replace_member_custom_data(
  p_member_id uuid,
  p_values jsonb default '[]'::jsonb,
  p_tag_ids uuid[] default array[]::uuid[]
)
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if p_member_id is null then raise exception 'Member is required'; end if;
  if p_values is null or jsonb_typeof(p_values) <> 'array' then
    raise exception 'Custom field values must be an array';
  end if;
  if jsonb_array_length(p_values) > 64 then
    raise exception 'Too many custom field values for one member';
  end if;
  if coalesce(array_length(p_tag_ids,1),0) > 100 then
    raise exception 'A member can have at most 100 tags';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(uid::text || ':member-custom:' || p_member_id::text,0)
  );

  perform 1 from public.members
  where id=p_member_id and user_id=uid
  for update;
  if not found then raise exception 'Member was not found'; end if;

  if exists (
    select 1 from (
      select item->>'field_id' field_id,count(*) c
      from jsonb_array_elements(p_values) item
      group by item->>'field_id'
    ) d
    where d.field_id is null or d.field_id='' or d.c>1
  ) then
    raise exception 'Custom field values contain a missing or duplicate field';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_values) item
    where coalesce(item->>'field_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or not exists (
         select 1 from public.member_field_definitions d
         where d.id=(item->>'field_id')::uuid and d.user_id=uid
       )
  ) then
    raise exception 'One or more custom fields do not belong to this account';
  end if;

  if exists (
    select 1 from unnest(coalesce(p_tag_ids,array[]::uuid[])) tag_id
    where not exists (
      select 1 from public.member_tags t
      where t.id=tag_id and t.user_id=uid
    )
  ) then
    raise exception 'One or more tags do not belong to this account';
  end if;

  if (
    select count(*) from unnest(coalesce(p_tag_ids,array[]::uuid[])) x
  ) <> (
    select count(distinct x) from unnest(coalesce(p_tag_ids,array[]::uuid[])) x
  ) then
    raise exception 'Duplicate tags are not allowed';
  end if;

  delete from public.member_field_values where user_id=uid and member_id=p_member_id;
  insert into public.member_field_values(user_id,member_id,field_id,value)
  select uid,p_member_id,(item->>'field_id')::uuid,item->'value'
  from jsonb_array_elements(p_values) item
  where item ? 'value' and item->'value' <> 'null'::jsonb;

  delete from public.member_tag_links where user_id=uid and member_id=p_member_id;
  insert into public.member_tag_links(user_id,member_id,tag_id)
  select uid,p_member_id,tag_id
  from unnest(coalesce(p_tag_ids,array[]::uuid[])) tag_id;

  return jsonb_build_object(
    'member_id',p_member_id,
    'values',(select count(*) from public.member_field_values where user_id=uid and member_id=p_member_id),
    'tags',(select count(*) from public.member_tag_links where user_id=uid and member_id=p_member_id)
  );
end
$$;

revoke all on function public.replace_member_custom_data(uuid,jsonb,uuid[]) from public,anon;
grant execute on function public.replace_member_custom_data(uuid,jsonb,uuid[]) to authenticated,service_role;
