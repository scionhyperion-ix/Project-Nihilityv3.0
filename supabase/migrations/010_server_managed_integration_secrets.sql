create table if not exists public.integration_secrets (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('pluralkit')),
  ciphertext text not null,
  iv text not null,
  cipher_version smallint not null default 1 check (cipher_version = 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table public.integration_secrets enable row level security;

revoke all privileges on public.integration_secrets from public, anon, authenticated;
grant select, insert, update, delete on public.integration_secrets to service_role;

drop trigger if exists integration_secrets_set_updated_at on public.integration_secrets;
create trigger integration_secrets_set_updated_at
before update on public.integration_secrets
for each row execute function public.set_updated_at();
