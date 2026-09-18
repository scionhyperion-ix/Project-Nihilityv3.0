create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

drop function if exists public.bootstrap_or_accept_profile();
drop function if exists public.invite_account(text);

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  mail text := lower(coalesce(new.email, ''));
begin
  if mail = '' then return new; end if;

  if not exists (select 1 from public.profiles) then
    insert into public.profiles(user_id,email,display_name,role)
    values(new.id,mail,split_part(mail,'@',1),'owner')
    on conflict (user_id) do nothing;
    return new;
  end if;

  if exists (
    select 1 from public.account_invites
    where lower(email)=mail and accepted_at is null
  ) then
    insert into public.profiles(user_id,email,display_name,role)
    values(new.id,mail,split_part(mail,'@',1),'member')
    on conflict (user_id) do nothing;

    update public.account_invites
      set accepted_at=now()
      where lower(email)=mail and accepted_at is null;
  end if;

  return new;
end;
$$;

create or replace function private.handle_new_invite()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_user uuid;
begin
  select id into existing_user
  from auth.users
  where lower(email)=lower(new.email)
  limit 1;

  if existing_user is not null then
    insert into public.profiles(user_id,email,display_name,role)
    values(existing_user,lower(new.email),split_part(lower(new.email),'@',1),'member')
    on conflict (user_id) do nothing;

    new.accepted_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists nihility_auth_user_bootstrap on auth.users;
create trigger nihility_auth_user_bootstrap
after insert on auth.users
for each row execute function private.handle_new_auth_user();

drop trigger if exists nihility_invite_accept_existing_user on public.account_invites;
create trigger nihility_invite_accept_existing_user
before insert or update of email on public.account_invites
for each row execute function private.handle_new_invite();

create index if not exists account_invites_invited_by_idx
on public.account_invites(invited_by);
