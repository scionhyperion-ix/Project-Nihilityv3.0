-- Keep profile updates least-privilege while allowing the new banner fields.
revoke update on public.profiles from authenticated;
grant update (
  display_name,
  avatar_url,
  avatar_storage_path,
  banner_url,
  banner_storage_path
) on public.profiles to authenticated;
