-- MyTrashBid — money policy: fold job/bid minimum and maximum limits into the existing
-- platform_fee_config (see 20260817000000) rather than a second single-row config table — same
-- storage/RLS/audit-log/permission-split concerns, just two more columns.
--
-- Super-admin-only, with NO allow_admin_fee_edits-style delegation path: unlike day-to-day fee
-- tuning, these caps directly shape fraud/chargeback exposure and marketplace economics, so they
-- stay with the top role always — a regular admin can view but never edit them, full stop.
--
-- Enforced via a BEFORE INSERT OR UPDATE trigger on bids rather than folded into bids_insert/
-- bids_update RLS: RLS's WITH CHECK only ever produces a generic 42501 with no way to say which
-- rule failed, but the requirement here is two different, specific messages — a clear "too low"
-- rejection, and a graceful "contact us" redirect for amounts over the cap (never a dead-end
-- error). A BEFORE ROW trigger runs before RLS's WITH CHECK is evaluated, so raising here reliably
-- reaches the client instead of being shadowed by RLS's own generic denial. jobs has no
-- customer-stated dollar amount at all (only bids carry a price), so this is the only enforcement
-- point needed — there's nothing to check at job-posting time.

alter table platform_fee_config
  add column min_bid_amount numeric(10,2) not null default 40,
  add column max_job_amount numeric(10,2) not null default 2000;

alter table platform_fee_audit_log drop constraint platform_fee_audit_log_action_check;
alter table platform_fee_audit_log add constraint platform_fee_audit_log_action_check
  check (action in ('global_rate_set', 'tier_rate_set', 'admin_edit_toggle_set', 'min_bid_set', 'max_job_set'));

-- ── Super-admin-only RPCs — cross-validated against each other so the config can never end up
-- with min >= max. ──────────────────────────────────────────────────────────────────────────────
create function set_min_bid_amount(p_amount numeric) returns void
language plpgsql security definer set search_path = public as $$
declare v_cfg platform_fee_config%rowtype;
begin
  if not is_super_admin() then
    raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only the super admin can change the minimum bid amount.';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Minimum bid amount must be greater than $0.';
  end if;
  select * into v_cfg from platform_fee_config where id = true for update;
  if p_amount >= v_cfg.max_job_amount then
    raise exception 'Minimum bid amount must be less than the maximum job amount ($%).', v_cfg.max_job_amount;
  end if;

  update platform_fee_config set min_bid_amount = p_amount, updated_at = now() where id = true;
  perform log_platform_fee_change('min_bid_set', null, v_cfg.min_bid_amount::text, p_amount::text);
end;
$$;
revoke execute on function set_min_bid_amount(numeric) from public;
grant execute on function set_min_bid_amount(numeric) to authenticated;

create function set_max_job_amount(p_amount numeric) returns void
language plpgsql security definer set search_path = public as $$
declare v_cfg platform_fee_config%rowtype;
begin
  if not is_super_admin() then
    raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only the super admin can change the maximum job amount.';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Maximum job amount must be greater than $0.';
  end if;
  select * into v_cfg from platform_fee_config where id = true for update;
  if p_amount <= v_cfg.min_bid_amount then
    raise exception 'Maximum job amount must be greater than the minimum bid amount ($%).', v_cfg.min_bid_amount;
  end if;

  update platform_fee_config set max_job_amount = p_amount, updated_at = now() where id = true;
  perform log_platform_fee_change('max_job_set', null, v_cfg.max_job_amount::text, p_amount::text);
end;
$$;
revoke execute on function set_max_job_amount(numeric) from public;
grant execute on function set_max_job_amount(numeric) to authenticated;

-- ── Enforcement trigger — fires on both submitBid (insert) and updateBid (a hauler editing their
-- own pending bid). Codes match the CODE_NAME: convention parseRpcError() already understands (see
-- 20260815000000_account_deletion_and_suspension.sql), so the client surfaces these messages
-- verbatim instead of a generic failure. ────────────────────────────────────────────────────────
create function enforce_bid_amount_limits() returns trigger
  language plpgsql security definer set search_path = public as $$
declare v_min numeric; v_max numeric;
begin
  select min_bid_amount, max_job_amount into v_min, v_max from platform_fee_config where id = true;
  if new.amount < v_min then
    raise exception 'BID_TOO_LOW: Bids must be at least $% — enter a higher amount.', v_min;
  end if;
  if new.amount > v_max then
    raise exception 'MAX_JOB_AMOUNT: For jobs over $%, please contact us at support@mytrashbid.com so we can help you directly.', v_max;
  end if;
  return new;
end;
$$;

create trigger bids_enforce_amount_limits before insert or update on bids
  for each row execute function enforce_bid_amount_limits();
