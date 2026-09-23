-- PluralKit front sharing is now explicit/manual.
-- Keep the legacy column for compatibility, but disable it permanently for
-- browser clients and default all integrations to no automatic sharing.

alter table public.external_integrations
  alter column share_fronting_updates set default false;

update public.external_integrations
set share_fronting_updates=false
where share_fronting_updates is distinct from false;

revoke update (share_fronting_updates)
on public.external_integrations
from authenticated;
