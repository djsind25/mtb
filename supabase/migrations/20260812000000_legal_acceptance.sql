-- Append-only record of which version of the Terms of Service / Privacy Policy each user has
-- accepted, and when. A new row per acceptance — never updated or deleted — so there's always a
-- full history of what a user agreed to, not just their latest status. The current version
-- numbers this checks against live in web/src/legal/legalContent.js; bumping one there and
-- redeploying causes every existing customer/hauler to be re-prompted next login (see
-- has_current_legal_acceptance below and App.jsx's legal_reaccept stage).
create table legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  document text not null check (document in ('tos', 'privacy')),
  version integer not null check (version >= 1),
  accepted_at timestamptz not null default now()
);

create index legal_acceptances_user_id_idx on legal_acceptances(user_id);

alter table legal_acceptances enable row level security;

grant select on legal_acceptances to authenticated;

-- A user can see their own acceptance history (Account tab shows "Accepted Terms v1 on ...").
create policy legal_acceptances_select_own on legal_acceptances for select
  using (user_id = auth.uid());

-- Full admins can see everyone's history — the actual point of this table is being able to answer
-- "did user X agree, to which version, and when" for a dispute or compliance request.
create policy legal_acceptances_select_admin on legal_acceptances for select
  using (is_full_admin());

-- No insert/update/delete policy for direct client writes on the table itself — every write goes
-- through this RPC, which pins user_id to auth.uid() server-side so a user can never record an
-- acceptance under someone else's identity or backdate/alter an existing row. Nothing here ever
-- updates or deletes a prior row, keeping the table genuinely append-only.
create function record_legal_acceptance(p_document text, p_version integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_document not in ('tos', 'privacy') then
    raise exception 'Invalid document type.';
  end if;
  if p_version is null or p_version < 1 then
    raise exception 'Invalid version.';
  end if;
  insert into legal_acceptances (user_id, document, version)
  values (auth.uid(), p_document, p_version);
end;
$$;

grant execute on function record_legal_acceptance(text, integer) to authenticated;

-- Lets the app ask "does this user already have a current-version acceptance for both docs" in
-- one round trip without exposing the raw table shape to the client just for this check.
create function has_current_legal_acceptance(p_tos_version integer, p_privacy_version integer)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (select 1 from legal_acceptances where user_id = auth.uid() and document = 'tos' and version >= p_tos_version)
    and exists (select 1 from legal_acceptances where user_id = auth.uid() and document = 'privacy' and version >= p_privacy_version);
$$;

grant execute on function has_current_legal_acceptance(integer, integer) to authenticated;
