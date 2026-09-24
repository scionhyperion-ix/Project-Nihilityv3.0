-- First-class member-to-member relationships.

create table public.member_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_member_id uuid not null,
  target_member_id uuid not null,
  source_label text not null,
  target_label text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_connections_source_owner_fkey
    foreign key(source_member_id,user_id) references public.members(id,user_id) on delete cascade,
  constraint member_connections_target_owner_fkey
    foreign key(target_member_id,user_id) references public.members(id,user_id) on delete cascade,
  constraint member_connections_distinct_members check (source_member_id <> target_member_id),
  constraint member_connections_source_label_length check (length(source_label) between 1 and 80),
  constraint member_connections_target_label_length check (length(target_label) between 1 and 80)
);

create unique index member_connections_user_pair_unique
  on public.member_connections(
    user_id,
    least(source_member_id,target_member_id),
    greatest(source_member_id,target_member_id)
  );

create index member_connections_source_owner_idx
  on public.member_connections(source_member_id,user_id);
create index member_connections_target_owner_idx
  on public.member_connections(target_member_id,user_id);
create index member_connections_user_updated_idx
  on public.member_connections(user_id,updated_at desc);

create or replace function private.validate_member_connection()
returns trigger
language plpgsql
security invoker
set search_path=''
as $connection$
declare
  v_source_count integer;
  v_target_count integer;
begin
  new.source_label := btrim(new.source_label);
  new.target_label := btrim(new.target_label);

  if new.source_label='' or new.target_label='' then
    raise exception 'Relationship labels cannot be empty';
  end if;

  if tg_op='INSERT' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(new.user_id::text || ':member-connections',0)
    );
    perform pg_catalog.pg_advisory_xact_lock(
      least(
        pg_catalog.hashtextextended(new.user_id::text || ':member-connection:' || new.source_member_id::text,0),
        pg_catalog.hashtextextended(new.user_id::text || ':member-connection:' || new.target_member_id::text,0)
      )
    );
    perform pg_catalog.pg_advisory_xact_lock(
      greatest(
        pg_catalog.hashtextextended(new.user_id::text || ':member-connection:' || new.source_member_id::text,0),
        pg_catalog.hashtextextended(new.user_id::text || ':member-connection:' || new.target_member_id::text,0)
      )
    );

    if (
      select count(*) from public.member_connections c where c.user_id=new.user_id
    ) >= 10000 then
      raise exception 'Nihility supports up to 10000 member connections per account';
    end if;

    select count(*) into v_source_count
    from public.member_connections c
    where c.user_id=new.user_id
      and (c.source_member_id=new.source_member_id or c.target_member_id=new.source_member_id);

    select count(*) into v_target_count
    from public.member_connections c
    where c.user_id=new.user_id
      and (c.source_member_id=new.target_member_id or c.target_member_id=new.target_member_id);

    if v_source_count >= 250 or v_target_count >= 250 then
      raise exception 'A member can have at most 250 direct connections';
    end if;
  end if;

  return new;
end
$connection$;

revoke all on function private.validate_member_connection() from public,anon,authenticated;

create trigger member_connections_validate
before insert or update on public.member_connections
for each row execute function private.validate_member_connection();

create trigger member_connections_set_updated_at
before update on public.member_connections
for each row execute function public.set_updated_at();

alter table public.member_connections enable row level security;

create policy member_connections_own
on public.member_connections
for all
to authenticated
using (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()))
)
with check (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()))
);

revoke all on public.member_connections from anon,authenticated;
grant select,insert,update,delete on public.member_connections to authenticated;
