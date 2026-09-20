alter table public.profiles
  add column if not exists banner_url text,
  add column if not exists banner_storage_path text;

comment on column public.profiles.banner_url is 'Optional external profile banner URL when not copied into private storage.';
comment on column public.profiles.banner_storage_path is 'Private Nihility banner storage path for the account profile.';
