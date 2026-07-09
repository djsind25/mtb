-- Public-safe tally of completed jobs, used as a trust signal shown to customers
-- alongside their quotes. Bypasses jobs_select RLS via SECURITY DEFINER since it
-- only ever returns a single aggregate count, never row-level job data.
create or replace function completed_jobs_count()
returns bigint
language sql
security definer
set search_path = public
stable
as $$
  select count(*) from jobs where completed = true;
$$;

grant execute on function completed_jobs_count() to authenticated;
