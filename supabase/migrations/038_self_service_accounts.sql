-- Transition Nihility from owner-invite registration to independent self-service accounts.
-- Existing accounts and internal roles remain intact for compatibility.

create or replace function private.authorize_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path=''
as $registration$
begin
  if pg_catalog.lower(pg_catalog.coalesce(new.email,''))='' then
    raise exception 'Email is required';
  end if;
  return new;
end
$registration$;

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path=''
as $registration$
declare
  mail text := pg_catalog.lower(pg_catalog.coalesce(new.email,''));
  configured_owner text;
  account_role text := 'member';
begin
  select pg_catalog.lower(owner_email)
  into configured_owner
  from private.instance_config
  where id=true;

  if configured_owner is not null and mail=configured_owner then
    account_role:='owner';
  end if;

  insert into public.profiles(user_id,email,display_name,role)
  values(
    new.id,
    mail,
    pg_catalog.split_part(mail,'@',1),
    account_role
  )
  on conflict (user_id) do nothing;

  return new;
end
$registration$;

-- Invites are retained only as legacy records. New registrations no longer
-- depend on account_invites and no new invite UI is exposed.
