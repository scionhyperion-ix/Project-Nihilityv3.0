
revoke all privileges on public.external_integrations from authenticated;
grant select on public.external_integrations to authenticated;
grant update (share_fronting_updates) on public.external_integrations to authenticated;
