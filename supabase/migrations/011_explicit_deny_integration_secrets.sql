
drop policy if exists "integration_secrets_client_deny" on public.integration_secrets;
create policy "integration_secrets_client_deny"
on public.integration_secrets
for all
to anon, authenticated
using (false)
with check (false);
