-- MyTrashBid — Lead Tracking: two independent pipelines behind one "Leads" admin area.
--
-- Pipeline 1 (customer stalls) is purely DERIVED — no new records for jobs/bids/profiles, just a
-- read-only categorization computed on load (same "compute on load from timestamps" pattern this
-- app already uses everywhere else, e.g. sync_full_payment_schedule/expires_at triggers — no new
-- background worker). admin_lead_dismissals is the one small piece of real state this pipeline
-- needs: derived rows have no natural home to mark "handled," so dismissal is tracked by
-- (category, ref_id) instead.
--
-- Pipeline 2 (hauler recruiting) is a genuine manual CRM — haulers being recruited are NOT yet
-- users, so this is real data admin types in by hand, with an append-only activity log (same
-- ledger idiom as account_lifecycle_audit_log: dedicated table, is_admin()-only select, no
-- insert/update policy, written only via a security definer RPC).
--
-- Deliberately NOT built: no automated messaging, AI, or auto-follow-up — this only surfaces and
-- tracks. next_followup_date is a plain date the admin sets by hand; a future automated/AI layer
-- could query `where next_followup_date <= current_date and stage not in ('signed_up','verified',
-- 'active','not_interested','dormant')` to know what's due, but nothing acts on that today — this
-- comment marks the seam, not an implementation.

insert into app_config (key, value) values
  ('stall_no_bids_hours', '48'),
  ('stall_no_acceptance_hours', '72'),
  ('stall_abandoned_signup_hours', '48')
on conflict (key) do nothing;

-- ═══ Pipeline 1 — dismissal tracking for derived customer-stall leads ═══════════════════════════
create table admin_lead_dismissals (
  id         uuid primary key default gen_random_uuid(),
  category   text not null check (category in ('expired_unbooked', 'no_bids', 'no_acceptance', 'stalled_coordination', 'abandoned_signup')),
  ref_id     uuid not null,
  status     text not null default 'reviewed' check (status in ('reviewed', 'resolved')),
  admin_id   uuid references profiles(id),
  created_at timestamptz not null default now(),
  unique (category, ref_id)
);
alter table admin_lead_dismissals enable row level security;

create policy admin_lead_dismissals_select on admin_lead_dismissals for select
  to authenticated using (is_admin());
create policy admin_lead_dismissals_insert on admin_lead_dismissals for insert
  to authenticated with check (is_full_admin() and admin_id = auth.uid());
create policy admin_lead_dismissals_delete on admin_lead_dismissals for delete
  to authenticated using (is_full_admin());

grant select, insert, delete on admin_lead_dismissals to authenticated;
grant all on admin_lead_dismissals to service_role;

-- Job-based categories in one function so priority between them lives in exactly one place —
-- expired beats no-acceptance beats no-bids, so a job never double-counts across categories.
-- Excludes already-dismissed rows server-side (defense in depth; the client also filters).
create function admin_customer_stall_categories()
returns table (category text, job_id uuid, customer_id uuid, job_title text, zip text, bid_count int, since timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_no_bids_hours numeric := app_config_numeric('stall_no_bids_hours');
  v_no_accept_hours numeric := app_config_numeric('stall_no_acceptance_hours');
begin
  if not is_admin() then
    raise exception 'Admins only';
  end if;

  return query
  with bid_counts as (
    select b.job_id, count(*)::int as cnt, min(b.created_at) as first_bid_at
    from bids b group by b.job_id
  ),
  categorized as (
    select
      case
        when j.expires_at <= now() then 'expired_unbooked'
        when coalesce(bc.cnt, 0) = 0 and j.first_posted_at <= now() - make_interval(hours => v_no_bids_hours::int) then 'no_bids'
        when coalesce(bc.cnt, 0) > 0 and bc.first_bid_at <= now() - make_interval(hours => v_no_accept_hours::int) then 'no_acceptance'
        else null
      end as cat,
      j.id as jid, j.customer_id as cid, j.title as jtitle, j.zip as jzip,
      coalesce(bc.cnt, 0) as bcount,
      case
        when j.expires_at <= now() then j.expires_at
        when coalesce(bc.cnt, 0) = 0 then j.first_posted_at
        else bc.first_bid_at
      end as since_at
    from jobs j
    left join bid_counts bc on bc.job_id = j.id
    where j.status = 'open'
  )
  select c.cat, c.jid, c.cid, c.jtitle, c.jzip, c.bcount, c.since_at
  from categorized c
  where c.cat is not null
    and not exists (select 1 from admin_lead_dismissals d where d.category = c.cat and d.ref_id = c.jid)
  order by c.since_at asc;
end;
$$;
revoke execute on function admin_customer_stall_categories() from public;
grant execute on function admin_customer_stall_categories() to authenticated;

-- Profile-based category, kept separate from the job-based function above rather than forced into
-- a mismatched-columns UNION — the client merges both into one list. Only customers past
-- signup (a profiles row exists pre-email-confirmation, see handle_new_user()) with zero jobs
-- posted count as abandoned; there's no way to detect someone who never submitted the form at all.
create function admin_abandoned_signups()
returns table (customer_id uuid, name text, email text, zip text, since timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_hours numeric := app_config_numeric('stall_abandoned_signup_hours');
begin
  if not is_admin() then
    raise exception 'Admins only';
  end if;

  return query
  select p.id, p.name, p.email, p.zip, p.created_at
  from profiles p
  where p.role = 'customer'
    and p.email_verified_at is null
    and p.created_at <= now() - make_interval(hours => v_hours::int)
    and not exists (select 1 from jobs j where j.customer_id = p.id)
    and not exists (select 1 from admin_lead_dismissals d where d.category = 'abandoned_signup' and d.ref_id = p.id)
  order by p.created_at asc;
end;
$$;
revoke execute on function admin_abandoned_signups() from public;
grant execute on function admin_abandoned_signups() to authenticated;

-- ═══ Pipeline 2 — hauler recruiting CRM ══════════════════════════════════════════════════════════
create table hauler_recruiting_leads (
  id                 uuid primary key default gen_random_uuid(),
  business_name      text not null,
  contact_name       text,
  phone              text,
  email              text,
  zip                text,
  source             text,
  notes              text,
  stage              text not null default 'to_contact'
    check (stage in ('to_contact', 'contacted', 'interested', 'signed_up', 'verified', 'active', 'not_interested', 'dormant')),
  last_contacted_at  date,
  next_followup_at   date,
  linked_hauler_id   uuid references profiles(id),
  created_by         uuid references profiles(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index hauler_recruiting_leads_stage_idx on hauler_recruiting_leads(stage);

alter table hauler_recruiting_leads enable row level security;
create policy hauler_recruiting_leads_select on hauler_recruiting_leads for select
  to authenticated using (is_admin());
create policy hauler_recruiting_leads_insert on hauler_recruiting_leads for insert
  to authenticated with check (is_full_admin());
create policy hauler_recruiting_leads_update on hauler_recruiting_leads for update
  to authenticated using (is_full_admin()) with check (is_full_admin());

grant select, insert, update on hauler_recruiting_leads to authenticated;
grant all on hauler_recruiting_leads to service_role;

create function touch_hauler_recruiting_lead() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger hauler_recruiting_leads_touch before update on hauler_recruiting_leads
  for each row execute function touch_hauler_recruiting_lead();

-- Append-only activity log — same idiom as account_lifecycle_audit_log: no insert policy at all,
-- written only through add_recruiting_lead_note() below.
create table hauler_lead_activity_log (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references hauler_recruiting_leads(id) on delete cascade,
  note       text not null,
  admin_id   uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index hauler_lead_activity_log_lead_id_idx on hauler_lead_activity_log(lead_id);

alter table hauler_lead_activity_log enable row level security;
create policy hauler_lead_activity_log_select on hauler_lead_activity_log for select
  to authenticated using (is_admin());

grant select on hauler_lead_activity_log to authenticated;
grant all on hauler_lead_activity_log to service_role;

create function add_recruiting_lead_note(p_lead_id uuid, p_note text) returns uuid
  language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not is_full_admin() then
    raise exception 'Only full admins can add recruiting notes';
  end if;
  if p_note is null or trim(p_note) = '' then
    raise exception 'Note text is required';
  end if;
  insert into hauler_lead_activity_log (lead_id, note, admin_id)
  values (p_lead_id, trim(p_note), auth.uid())
  returning id into v_id;
  update hauler_recruiting_leads set updated_at = now() where id = p_lead_id;
  return v_id;
end;
$$;
revoke execute on function add_recruiting_lead_note(uuid, text) from public;
grant execute on function add_recruiting_lead_note(uuid, text) to authenticated;

-- Linking is its own RPC (not a plain column update) so it can validate the target is actually a
-- hauler account before wiring the two together.
create function link_recruiting_lead(p_lead_id uuid, p_hauler_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  if not is_full_admin() then
    raise exception 'Only full admins can link recruiting leads';
  end if;
  select role into v_role from profiles where id = p_hauler_id;
  if v_role is distinct from 'hauler' then
    raise exception 'That account is not a hauler';
  end if;
  update hauler_recruiting_leads
    set linked_hauler_id = p_hauler_id, stage = case when stage in ('to_contact', 'contacted', 'interested') then 'signed_up' else stage end
    where id = p_lead_id;
end;
$$;
revoke execute on function link_recruiting_lead(uuid, uuid) from public;
grant execute on function link_recruiting_lead(uuid, uuid) to authenticated;

create function unlink_recruiting_lead(p_lead_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not is_full_admin() then
    raise exception 'Only full admins can unlink recruiting leads';
  end if;
  update hauler_recruiting_leads set linked_hauler_id = null where id = p_lead_id;
end;
$$;
revoke execute on function unlink_recruiting_lead(uuid) from public;
grant execute on function unlink_recruiting_lead(uuid) to authenticated;
