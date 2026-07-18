-- MyTrashBid — full-payment mode (Phase 1 of the payment rework)
--
-- The payment_mode seam ('deposit' | 'full') has existed in the schema since day one, and
-- accept_bid() already branches its system message on it, but price_breakdown()'s actual math
-- never treated 'full' differently — the seam was wired but never activated. This turns it on:
-- new jobs default to 'full' (charge-and-hold the whole bid amount, released to the hauler on
-- dual completion confirmation — see 20260721000000_job_completion_workflow.sql), with an
-- admin-flippable switch back to 'deposit'.
--
-- payment_mode is stamped once per job at INSERT time (in set_job_expiry(), same trigger that
-- already stamps expires_at/lat/lng) and never touched again — so every already-booked job keeps
-- whatever mode it was created under. Nothing here retroactively changes existing test jobs.

insert into app_config (key, value) values ('default_payment_mode', 'full')
  on conflict (key) do nothing;

-- Deliberately NOT a generic "read any app_config key by name" helper — that shape would let
-- anyone read internal_dispatch_key straight through the RPC endpoint (app_config_text('...')
-- callable by anon). Hardcoding the key keeps this to exactly the one non-sensitive value it's
-- meant to expose, same safety reasoning as the rest of the recent lockdown work.
create function get_default_payment_mode() returns text
  language sql stable security definer set search_path = public as $$
    select value from app_config where key = 'default_payment_mode';
  $$;

create or replace function set_job_expiry() returns trigger
  language plpgsql as $$
declare
  v_days int;
  v_verified boolean;
begin
  select (email_verified_at is not null) into v_verified from profiles where id = new.customer_id;

  if not coalesce(v_verified, false) then
    new.status := 'pending_verification';
    new.expires_at := null;
  else
    v_days := case when new.service_type = 'rental'
      then app_config_numeric('rental_live_window_days')::int
      else app_config_numeric('live_window_days')::int
    end;
    new.expires_at := new.created_at + make_interval(days => v_days);
  end if;

  if new.zip is not null then
    select lat, lng into new.lat, new.lng from zip_geo where zip = trim(new.zip);
  end if;

  new.payment_mode := get_default_payment_mode();

  return new;
end;
$$;

-- 'full' mode charges the entire bid amount now (deposit_now = amount, balance_due = 0) instead
-- of 10% now / 90% hauler-direct later. fee stays the same 10% calculation either way — in full
-- mode it isn't charged separately, it's carved out of the same charge at release time
-- (customer_acknowledge_completion() flipping commission_status to 'earned' *is* the release
-- event; no Stripe transfer happens since haulers aren't Connect accounts — release is a
-- bookkeeping state the admin pays out against off-platform, same as deposit mode's 90% today).
create or replace function price_breakdown(p_amount numeric, p_payment_mode text default 'deposit')
returns table (amount numeric, fee numeric, deposit_now numeric, balance_due numeric)
language sql stable as $$
  select
    p_amount,
    round(p_amount * app_config_numeric('commission_rate'), 2),
    case when p_payment_mode = 'full' then p_amount
      else round(p_amount * app_config_numeric('commission_rate'), 2)
    end,
    case when p_payment_mode = 'full' then 0
      else round(p_amount - round(p_amount * app_config_numeric('commission_rate'), 2), 2)
    end;
$$;

create function set_default_payment_mode(p_mode text) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not is_super_admin() then
    raise exception 'Only the super admin can change this setting';
  end if;
  if p_mode not in ('deposit', 'full') then
    raise exception 'Invalid payment mode';
  end if;
  update app_config set value = p_mode where key = 'default_payment_mode';
end;
$$;
revoke execute on function set_default_payment_mode(text) from public;
grant execute on function set_default_payment_mode(text) to authenticated;
