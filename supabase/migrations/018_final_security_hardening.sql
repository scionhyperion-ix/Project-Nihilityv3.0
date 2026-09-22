-- Final security hardening after the second full audit.
-- Fixes cipher-version migration, profile revocation gaps, per-account row
-- quotas, race-safe media quota reservations, and bounded audit retention.

-- Allow the Edge Function to transparently migrate existing PluralKit
-- credentials from legacy cipher v1 to the dedicated Vault-backed cipher v2.
alter table public.integration_secrets
  drop constraint if exists integration_secrets_cipher_version_check;

alter table public.integration_secrets
  alter column cipher_version set default 2;

alter table public.integration_secrets
  add constraint integration_secrets_cipher_version_check
  check (cipher_version in (1,2));

-- Revoking/removing a Nihility profile should revoke every browser-visible
-- integration/media capability for that auth user.
drop policy if exists "integration_owner_all" on public.external_integrations;
create policy "integration_owner_all"
on public.external_integrations
for all
to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.profiles p
    where p.user_id = (select auth.uid())
  )
)
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.profiles p
    where p.user_id = (select auth.uid())
  )
);

drop policy if exists "nihility_media_select_own_path" on storage.objects;
create policy "nihility_media_select_own_path"
on storage.objects
for select
to authenticated
using (
  bucket_id in ('nihility-avatars','nihility-banners','nihility-profile-avatars')
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and exists (
    select 1 from public.profiles p
    where p.user_id = (select auth.uid())
  )
);

drop policy if exists "nihility_media_delete_own_path" on storage.objects;
create policy "nihility_media_delete_own_path"
on storage.objects
for delete
to authenticated
using (
  bucket_id in ('nihility-avatars','nihility-banners','nihility-profile-avatars')
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and exists (
    select 1 from public.profiles p
    where p.user_id = (select auth.uid())
  )
);

-- Per-account row quotas stop a compromised invited account from filling the
-- database indefinitely through direct PostgREST writes. Limits are generous
-- enough for very large systems and historical front logs.
create or replace function private.enforce_nihility_row_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_limit bigint;
  v_count bigint;
  v_owner_column text := 'user_id';
begin
  case tg_table_name
    when 'members' then v_limit := 10000;
    when 'groups' then v_limit := 5000;
    when 'member_groups' then v_limit := 100000;
    when 'fronts' then v_limit := 200000;
    when 'front_members' then v_limit := 500000;
    when 'app_settings' then v_limit := 1;
    when 'imports' then v_limit := 50000;
    when 'account_invites' then
      v_limit := 5000;
      v_owner_column := 'invited_by';
    else
      return new;
  end case;

  if v_owner_column = 'invited_by' then
    v_user := (pg_catalog.to_jsonb(new)->>'invited_by')::uuid;
  else
    v_user := (pg_catalog.to_jsonb(new)->>'user_id')::uuid;
  end if;

  if v_user is null then
    raise exception 'Missing account owner for quota check';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user::text || ':' || tg_table_schema || '.' || tg_table_name, 0)
  );

  execute pg_catalog.format(
    'select count(*) from %I.%I where %I = $1',
    tg_table_schema,
    tg_table_name,
    v_owner_column
  )
  into v_count
  using v_user;

  if v_count >= v_limit then
    raise exception 'Account row quota reached for %', tg_table_name
      using errcode = '54000';
  end if;

  return new;
end
$$;

revoke all on function private.enforce_nihility_row_quota()
  from public, anon, authenticated;

drop trigger if exists quota_members on public.members;
create trigger quota_members before insert on public.members
for each row execute function private.enforce_nihility_row_quota();

drop trigger if exists quota_groups on public.groups;
create trigger quota_groups before insert on public.groups
for each row execute function private.enforce_nihility_row_quota();

drop trigger if exists quota_member_groups on public.member_groups;
create trigger quota_member_groups before insert on public.member_groups
for each row execute function private.enforce_nihility_row_quota();

drop trigger if exists quota_fronts on public.fronts;
create trigger quota_fronts before insert on public.fronts
for each row execute function private.enforce_nihility_row_quota();

drop trigger if exists quota_front_members on public.front_members;
create trigger quota_front_members before insert on public.front_members
for each row execute function private.enforce_nihility_row_quota();

drop trigger if exists quota_app_settings on public.app_settings;
create trigger quota_app_settings before insert on public.app_settings
for each row execute function private.enforce_nihility_row_quota();

drop trigger if exists quota_imports on public.imports;
create trigger quota_imports before insert on public.imports
for each row execute function private.enforce_nihility_row_quota();

drop trigger if exists quota_account_invites on public.account_invites;
create trigger quota_account_invites before insert on public.account_invites
for each row execute function private.enforce_nihility_row_quota();

-- Race-safe media quota reservations. A reservation is created before an
-- upload and then associated with the stored object. While Storage metadata is
-- not yet visible, the reservation still counts against the quota.
create table if not exists private.media_quota_reservations (
  reservation_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  bytes bigint not null check (bytes > 0 and bytes <= 10485760),
  bucket_id text,
  object_path text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  check (
    bucket_id is null
    or bucket_id in ('nihility-avatars','nihility-banners','nihility-profile-avatars')
  )
);

create index if not exists media_quota_reservations_expiry_idx
  on private.media_quota_reservations(expires_at);

create index if not exists media_quota_reservations_user_idx
  on private.media_quota_reservations(user_id);

revoke all on private.media_quota_reservations
  from public, anon, authenticated;

create or replace function public.reserve_nihility_media_quota(
  p_user_id uuid,
  p_reservation_id uuid,
  p_bytes bigint,
  p_limit_bytes bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_used bigint;
  v_reserved bigint;
begin
  if p_user_id is null
     or p_reservation_id is null
     or p_bytes <= 0
     or p_bytes > 10485760
     or p_limit_bytes < p_bytes
     or p_limit_bytes > 10737418240 then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':nihility-media-quota', 0)
  );

  delete from private.media_quota_reservations
  where expires_at <= pg_catalog.clock_timestamp();

  select coalesce(sum(coalesce((o.metadata->>'size')::bigint,0)),0)::bigint
  into v_used
  from storage.objects o
  where o.bucket_id in ('nihility-avatars','nihility-banners','nihility-profile-avatars')
    and pg_catalog.split_part(o.name,'/',1) = p_user_id::text;

  select coalesce(sum(r.bytes),0)::bigint
  into v_reserved
  from private.media_quota_reservations r
  where r.user_id = p_user_id
    and r.expires_at > pg_catalog.clock_timestamp()
    and (
      r.object_path is null
      or r.bucket_id is null
      or not exists (
        select 1
        from storage.objects o
        where o.bucket_id = r.bucket_id
          and o.name = r.object_path
      )
    );

  if v_used + v_reserved + p_bytes > p_limit_bytes then
    return false;
  end if;

  insert into private.media_quota_reservations(
    reservation_id,user_id,bytes
  )
  values (p_reservation_id,p_user_id,p_bytes);

  return true;
end
$$;

revoke all on function public.reserve_nihility_media_quota(uuid,uuid,bigint,bigint)
  from public, anon, authenticated;
grant execute on function public.reserve_nihility_media_quota(uuid,uuid,bigint,bigint)
  to service_role;

create or replace function public.finalize_nihility_media_reservation(
  p_user_id uuid,
  p_reservation_id uuid,
  p_bucket_id text,
  p_object_path text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null
     or p_reservation_id is null
     or p_bucket_id not in ('nihility-avatars','nihility-banners','nihility-profile-avatars')
     or p_object_path is null
     or pg_catalog.split_part(p_object_path,'/',1) <> p_user_id::text then
    raise exception 'Invalid media reservation finalization';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':nihility-media-quota', 0)
  );

  update private.media_quota_reservations
  set bucket_id = p_bucket_id,
      object_path = p_object_path,
      expires_at = pg_catalog.clock_timestamp() + interval '15 minutes'
  where reservation_id = p_reservation_id
    and user_id = p_user_id;
end
$$;

revoke all on function public.finalize_nihility_media_reservation(uuid,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.finalize_nihility_media_reservation(uuid,uuid,text,text)
  to service_role;

create or replace function public.release_nihility_media_reservation(
  p_user_id uuid,
  p_reservation_id uuid
)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.media_quota_reservations
  where user_id = p_user_id
    and reservation_id = p_reservation_id
$$;

revoke all on function public.release_nihility_media_reservation(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.release_nihility_media_reservation(uuid,uuid)
  to service_role;

-- Keep security events useful but bounded. Cleanup is probabilistic to avoid
-- a delete scan on every event while still preventing indefinite growth.
create or replace function public.record_nihility_security_event(
  p_user_id uuid,
  p_event_type text,
  p_success boolean,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.security_events(user_id, event_type, success, details)
  values (
    p_user_id,
    left(coalesce(p_event_type, 'unknown'), 80),
    coalesce(p_success, false),
    coalesce(p_details, '{}'::jsonb)
  );

  if random() < 0.02 then
    delete from private.security_events
    where created_at < pg_catalog.clock_timestamp() - interval '180 days';
  end if;
end
$$;

revoke all on function public.record_nihility_security_event(uuid,text,boolean,jsonb)
  from public, anon, authenticated;
grant execute on function public.record_nihility_security_event(uuid,text,boolean,jsonb)
  to service_role;
