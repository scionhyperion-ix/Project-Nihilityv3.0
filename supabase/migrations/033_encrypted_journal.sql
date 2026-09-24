-- Client-side encrypted journal vault.
-- The database stores only wrapped key material and encrypted entry payloads.
-- Browser roles receive no direct table access. Journal traffic goes through
-- nihility-secure, which validates the active authenticated session.

create table public.journal_vaults (
  user_id uuid primary key references auth.users(id) on delete cascade,
  format_version smallint not null default 1,
  cipher_suite text not null default 'AES-256-GCM',
  kdf_name text not null default 'PBKDF2-HMAC-SHA-256',
  kdf_iterations integer not null,
  kdf_salt text not null,
  wrap_iv text not null,
  wrapped_key text not null,
  recovery_kdf_name text not null default 'HKDF-SHA-256',
  recovery_salt text not null,
  recovery_iv text not null,
  recovery_wrapped_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint journal_vault_format_version_check check (format_version=1),
  constraint journal_vault_cipher_suite_check check (cipher_suite='AES-256-GCM'),
  constraint journal_vault_kdf_name_check check (kdf_name='PBKDF2-HMAC-SHA-256'),
  constraint journal_vault_kdf_iterations_check check (kdf_iterations between 600000 and 5000000),
  constraint journal_vault_recovery_kdf_check check (recovery_kdf_name='HKDF-SHA-256'),
  constraint journal_vault_kdf_salt_check check (
    length(kdf_salt) between 16 and 128 and kdf_salt ~ '^[A-Za-z0-9_-]+$'
  ),
  constraint journal_vault_wrap_iv_check check (
    length(wrap_iv) between 16 and 64 and wrap_iv ~ '^[A-Za-z0-9_-]+$'
  ),
  constraint journal_vault_wrapped_key_check check (
    length(wrapped_key) between 48 and 160 and wrapped_key ~ '^[A-Za-z0-9_-]+$'
  ),
  constraint journal_vault_recovery_salt_check check (
    length(recovery_salt) between 16 and 128 and recovery_salt ~ '^[A-Za-z0-9_-]+$'
  ),
  constraint journal_vault_recovery_iv_check check (
    length(recovery_iv) between 16 and 64 and recovery_iv ~ '^[A-Za-z0-9_-]+$'
  ),
  constraint journal_vault_recovery_wrapped_key_check check (
    length(recovery_wrapped_key) between 48 and 160 and recovery_wrapped_key ~ '^[A-Za-z0-9_-]+$'
  )
);

create trigger journal_vaults_set_updated_at
before update on public.journal_vaults
for each row execute function public.set_updated_at();

create table public.journal_entries (
  id uuid primary key,
  user_id uuid not null,
  payload_version smallint not null default 1,
  logical_date date not null,
  iv text not null,
  ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint journal_entries_vault_fkey
    foreign key(user_id) references public.journal_vaults(user_id) on delete cascade,
  constraint journal_entries_payload_version_check check (payload_version=1),
  constraint journal_entries_iv_check check (
    length(iv) between 16 and 64 and iv ~ '^[A-Za-z0-9_-]+$'
  ),
  constraint journal_entries_ciphertext_check check (
    length(ciphertext) between 24 and 350000 and ciphertext ~ '^[A-Za-z0-9_-]+$'
  )
);

create index journal_entries_user_date_idx
  on public.journal_entries(user_id,logical_date desc,updated_at desc,id desc);
create index journal_entries_user_updated_idx
  on public.journal_entries(user_id,updated_at desc,id desc);

create trigger journal_entries_set_updated_at
before update on public.journal_entries
for each row execute function public.set_updated_at();

alter table public.journal_vaults enable row level security;
alter table public.journal_entries enable row level security;

-- No browser policies are intentionally created.
revoke all on public.journal_vaults from public,anon,authenticated;
revoke all on public.journal_entries from public,anon,authenticated;
grant select,insert,update,delete on public.journal_vaults to service_role;
grant select,insert,update,delete on public.journal_entries to service_role;
