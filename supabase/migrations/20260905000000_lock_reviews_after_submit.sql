-- Reviews are permanent once submitted — the frontend already only offers a one-shot create
-- flow (see ReviewPanel.jsx), but the reviews_update_own policy still let a reviewer PATCH their
-- own row directly against the API. Drop it so that's enforced server-side too, not just by the
-- UI omitting an edit affordance.
drop policy if exists reviews_update_own on reviews;
