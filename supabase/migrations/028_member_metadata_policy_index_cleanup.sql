-- Performance and policy cleanup for member custom metadata.

drop policy if exists member_field_definitions_owner_write on public.member_field_definitions;
create policy member_field_definitions_owner_insert
on public.member_field_definitions for insert to authenticated
with check (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()) and p.role='owner')
);
create policy member_field_definitions_owner_update
on public.member_field_definitions for update to authenticated
using (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()) and p.role='owner')
)
with check (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()) and p.role='owner')
);
create policy member_field_definitions_owner_delete
on public.member_field_definitions for delete to authenticated
using (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()) and p.role='owner')
);

drop policy if exists member_tags_owner_write on public.member_tags;
create policy member_tags_owner_insert
on public.member_tags for insert to authenticated
with check (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()) and p.role='owner')
);
create policy member_tags_owner_update
on public.member_tags for update to authenticated
using (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()) and p.role='owner')
)
with check (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()) and p.role='owner')
);
create policy member_tags_owner_delete
on public.member_tags for delete to authenticated
using (
  user_id=(select auth.uid())
  and exists(select 1 from public.profiles p where p.user_id=(select auth.uid()) and p.role='owner')
);

create index if not exists member_field_values_field_owner_idx
  on public.member_field_values(field_id,user_id);
create index if not exists member_field_values_member_owner_idx
  on public.member_field_values(member_id,user_id);
create index if not exists member_tag_links_member_owner_idx
  on public.member_tag_links(member_id,user_id);
create index if not exists member_tag_links_tag_owner_idx
  on public.member_tag_links(tag_id,user_id);

drop index if exists public.member_field_values_field_idx;
drop index if exists public.member_tag_links_tag_idx;
