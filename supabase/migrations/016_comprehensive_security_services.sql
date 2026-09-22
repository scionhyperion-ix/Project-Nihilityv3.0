-- Comprehensive Nihility security hardening.
-- Service-only rate limiting, media quota accounting, dedicated Vault key,
-- security audit events, and server-side size constraints.

-- Dedicated encryption key, independent of the Supabase service-role JWT.
do $$
begin
  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'nihility_integration_key_v1'
  ) then
    perform vault.create_secret(
      encode(gen_random_bytes(32), 'base64'),
      'nihility_integration_key_v1',
      'Project Nihility integration-token encryption key',
      null
    );
  end if;
end
$$;

create or replace function public.get_nihility_encryption_key()
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'nihility_integration_key_v1'
  order by created_at desc
  limit 1
$$;

revoke all on function public.get_nihility_encryption_key() from public, anon, authenticated;
grant execute on function public.get_nihility_encryption_key() to service_role;

-- Fixed-window counters used only by the authenticated Edge Function.
create table if not exists private.security_rate_limits (
  user_id uuid not null,
  action text not null,
  window_start timestamptz not null,
  request_count integer not null default 1 check (request_count > 0),
  primary key (user_id, action, window_start)
);

revoke all on private.security_rate_limits from public, anon, authenticated;

create or replace function public.consume_nihility_rate_limit(
  p_user_id uuid,
  p_action text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_count integer;
begin
  if p_user_id is null
     or p_action is null
     or length(p_action) > 64
     or p_limit < 1 or p_limit > 10000
     or p_window_seconds < 1 or p_window_seconds > 86400 then
    return false;
  end if;

  v_window := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );

  insert into private.security_rate_limits(user_id, action, window_start, request_count)
  values (p_user_id, p_action, v_window, 1)
  on conflict (user_id, action, window_start)
  do update set request_count = private.security_rate_limits.request_count + 1
  returning request_count into v_count;

  if random() < 0.02 then
    delete from private.security_rate_limits
    where window_start < clock_timestamp() - interval '2 days';
  end if;

  return v_count <= p_limit;
end
$$;

revoke all on function public.consume_nihility_rate_limit(uuid,text,integer,integer)
  from public, anon, authenticated;
grant execute on function public.consume_nihility_rate_limit(uuid,text,integer,integer)
  to service_role;

-- Media usage is queried by the Edge Function before every new stored object.
create or replace function public.nihility_media_usage_bytes(p_user_id uuid)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select coalesce(sum(coalesce((metadata->>'size')::bigint, 0)), 0)::bigint
  from storage.objects
  where bucket_id in ('nihility-avatars','nihility-banners','nihility-profile-avatars')
    and split_part(name, '/', 1) = p_user_id::text
$$;

revoke all on function public.nihility_media_usage_bytes(uuid)
  from public, anon, authenticated;
grant execute on function public.nihility_media_usage_bytes(uuid)
  to service_role;

-- Append-only security audit records. Not exposed to browser roles.
create table if not exists private.security_events (
  id bigint generated always as identity primary key,
  user_id uuid,
  event_type text not null check (length(event_type) between 1 and 80),
  success boolean not null,
  details jsonb not null default '{}'::jsonb
    check (octet_length(details::text) <= 16384),
  created_at timestamptz not null default now()
);

create index if not exists security_events_user_created_idx
  on private.security_events(user_id, created_at desc);

revoke all on private.security_events from public, anon, authenticated;

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
end
$$;

revoke all on function public.record_nihility_security_event(uuid,text,boolean,jsonb)
  from public, anon, authenticated;
grant execute on function public.record_nihility_security_event(uuid,text,boolean,jsonb)
  to service_role;

-- Reasonable database-side limits. UI maxlength attributes are not security controls.
alter table public.profiles
  add constraint profiles_email_length_chk check (email is null or length(email) <= 320),
  add constraint profiles_display_name_length_chk check (display_name is null or length(display_name) <= 200),
  add constraint profiles_avatar_url_length_chk check (avatar_url is null or length(avatar_url) <= 2048),
  add constraint profiles_banner_url_length_chk check (banner_url is null or length(banner_url) <= 2048),
  add constraint profiles_avatar_path_length_chk check (avatar_storage_path is null or length(avatar_storage_path) <= 512),
  add constraint profiles_banner_path_length_chk check (banner_storage_path is null or length(banner_storage_path) <= 512);

alter table public.members
  add constraint members_name_length_chk check (length(name) between 1 and 200),
  add constraint members_display_name_length_chk check (display_name is null or length(display_name) <= 200),
  add constraint members_pronouns_length_chk check (pronouns is null or length(pronouns) <= 200),
  add constraint members_description_length_chk check (description is null or length(description) <= 10000),
  add constraint members_color_format_chk check (color is null or color ~ '^[0-9A-Fa-f]{6}$'),
  add constraint members_avatar_url_length_chk check (avatar_url is null or length(avatar_url) <= 2048),
  add constraint members_banner_url_length_chk check (banner_url is null or length(banner_url) <= 2048),
  add constraint members_source_length_chk check (
    (avatar_source is null or length(avatar_source) <= 32)
    and (banner_source is null or length(banner_source) <= 32)
  ),
  add constraint members_external_id_length_chk check (
    (pk_id is null or length(pk_id) <= 128)
    and (tupper_id is null or length(tupper_id) <= 128)
  ),
  add constraint members_storage_path_length_chk check (
    (avatar_storage_path is null or length(avatar_storage_path) <= 512)
    and (banner_storage_path is null or length(banner_storage_path) <= 512)
  ),
  add constraint members_metadata_size_chk check (octet_length(metadata::text) <= 65536);

alter table public.groups
  add constraint groups_name_length_chk check (length(name) between 1 and 200),
  add constraint groups_display_name_length_chk check (display_name is null or length(display_name) <= 200),
  add constraint groups_description_length_chk check (description is null or length(description) <= 10000),
  add constraint groups_color_format_chk check (color is null or color ~ '^[0-9A-Fa-f]{6}$'),
  add constraint groups_icon_url_length_chk check (icon_url is null or length(icon_url) <= 2048),
  add constraint groups_icon_source_length_chk check (icon_source is null or length(icon_source) <= 32),
  add constraint groups_external_id_length_chk check (
    (pk_id is null or length(pk_id) <= 128)
    and (tupper_id is null or length(tupper_id) <= 128)
  ),
  add constraint groups_icon_path_length_chk check (icon_storage_path is null or length(icon_storage_path) <= 512),
  add constraint groups_metadata_size_chk check (octet_length(metadata::text) <= 65536);

alter table public.fronts
  add constraint fronts_note_length_chk check (note is null or length(note) <= 10000),
  add constraint fronts_source_length_chk check (source is null or length(source) <= 32),
  add constraint fronts_external_id_length_chk check (external_id is null or length(external_id) <= 128),
  add constraint fronts_time_order_chk check (ended_at is null or ended_at >= started_at);

alter table public.app_settings
  add constraint app_settings_size_chk check (octet_length(settings::text) <= 131072);

alter table public.imports
  add constraint imports_source_length_chk check (length(source) between 1 and 32),
  add constraint imports_summary_size_chk check (octet_length(summary::text) <= 65536);

alter table public.account_invites
  add constraint account_invites_email_length_chk check (length(email) between 3 and 320);

alter table public.external_integrations
  add constraint external_integrations_provider_length_chk check (length(provider) between 1 and 32),
  add constraint external_integrations_system_id_length_chk check (external_system_id is null or length(external_system_id) <= 200),
  add constraint external_integrations_system_name_length_chk check (external_system_name is null or length(external_system_name) <= 200),
  add constraint external_integrations_metadata_size_chk check (octet_length(metadata::text) <= 65536);

-- Case-insensitive invite uniqueness.
create unique index if not exists account_invites_email_lower_unique_idx
  on public.account_invites (lower(email));

-- Audit direct database changes to security-sensitive account records.
create or replace function private.audit_nihility_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_event text;
begin
  v_user := coalesce((to_jsonb(new)->>'user_id')::uuid, (to_jsonb(old)->>'user_id')::uuid, auth.uid());
  v_event := 'db.' || tg_table_name || '.' || lower(tg_op);
  insert into private.security_events(user_id,event_type,success,details)
  values (
    v_user,
    left(v_event,80),
    true,
    jsonb_build_object('actor_user_id', auth.uid(), 'operation', tg_op)
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

revoke all on function private.audit_nihility_row_change() from public, anon, authenticated;

drop trigger if exists audit_profiles_security on public.profiles;
create trigger audit_profiles_security
after update on public.profiles
for each row execute function private.audit_nihility_row_change();

drop trigger if exists audit_invites_security on public.account_invites;
create trigger audit_invites_security
after insert or update or delete on public.account_invites
for each row execute function private.audit_nihility_row_change();

drop trigger if exists audit_integrations_security on public.external_integrations;
create trigger audit_integrations_security
after insert or update or delete on public.external_integrations
for each row execute function private.audit_nihility_row_change();
