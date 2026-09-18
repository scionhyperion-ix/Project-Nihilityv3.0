create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  display_name text,
  pronouns text,
  color text check (color is null or color ~ '^[0-9A-Fa-f]{6}$'),
  description text,
  birthday date,
  avatar_url text,
  avatar_source text check (avatar_source is null or avatar_source in ('external','r2')),
  banner_url text,
  banner_source text check (banner_source is null or banner_source in ('external','r2')),
  pk_id text,
  tupper_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  display_name text,
  description text,
  color text check (color is null or color ~ '^[0-9A-Fa-f]{6}$'),
  icon_url text,
  icon_source text check (icon_source is null or icon_source in ('external','r2')),
  pk_id text,
  tupper_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.member_groups (
  user_id uuid not null references auth.users(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(member_id, group_id)
);

create table public.fronts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  note text,
  source text not null default 'nihility',
  external_id text,
  created_at timestamptz not null default now()
);

create table public.front_members (
  user_id uuid not null references auth.users(id) on delete cascade,
  front_id uuid not null references public.fronts(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key(front_id, member_id, joined_at)
);

create table public.app_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('pluralkit','tupperbox','nihility')),
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index members_user_id_idx on public.members(user_id);
create index groups_user_id_idx on public.groups(user_id);
create index fronts_user_started_idx on public.fronts(user_id, started_at desc);
create index members_pk_id_idx on public.members(user_id, pk_id) where pk_id is not null;
create index members_tupper_id_idx on public.members(user_id, tupper_id) where tupper_id is not null;

create trigger members_set_updated_at before update on public.members for each row execute function public.set_updated_at();
create trigger groups_set_updated_at before update on public.groups for each row execute function public.set_updated_at();

alter table public.members enable row level security;
alter table public.groups enable row level security;
alter table public.member_groups enable row level security;
alter table public.fronts enable row level security;
alter table public.front_members enable row level security;
alter table public.app_settings enable row level security;
alter table public.imports enable row level security;

create policy "members_owner_all" on public.members for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "groups_owner_all" on public.groups for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "member_groups_owner_all" on public.member_groups for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "fronts_owner_all" on public.fronts for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "front_members_owner_all" on public.front_members for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "app_settings_owner_all" on public.app_settings for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "imports_owner_all" on public.imports for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
