-- hauler_recruiting_leads had select/insert/update policies but no delete path at all — a lead
-- entered by mistake, a duplicate, or spam had no way to be removed. Same permission tier as the
-- existing insert/update policies on this table (is_full_admin(), not is_super_admin() — this
-- isn't as sensitive as e.g. platform fee changes). The activity log already cascades (see
-- hauler_lead_activity_log's `references hauler_recruiting_leads(id) on delete cascade`).

create policy hauler_recruiting_leads_delete on hauler_recruiting_leads for delete
  to authenticated using (is_full_admin());

grant delete on hauler_recruiting_leads to authenticated;
