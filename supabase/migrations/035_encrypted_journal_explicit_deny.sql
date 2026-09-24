-- Explicit deny policies for service-only encrypted journal tables.
-- These remain protective even if browser table grants are accidentally added later.

create policy journal_vaults_deny_browser
on public.journal_vaults
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

create policy journal_entries_deny_browser
on public.journal_entries
as restrictive
for all
to anon, authenticated
using (false)
with check (false);
