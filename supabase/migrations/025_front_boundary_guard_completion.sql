-- Complete boundary validation found during the post-deploy audit.

create or replace function private.guard_front_boundaries()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.front_members fm
    where fm.front_id=new.id
      and fm.user_id=new.user_id
      and (
        fm.joined_at < new.started_at
        or (
          new.ended_at is not null
          and (
            fm.joined_at > new.ended_at
            or (fm.left_at is not null and fm.left_at > new.ended_at)
          )
        )
      )
  ) then
    raise exception 'Front boundaries would exclude existing fronter timing';
  end if;
  return new;
end
$$;

revoke all on function private.guard_front_boundaries()
  from public,anon,authenticated;
