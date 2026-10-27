-- The app admin sees every lab's people on the org chart.   27 Oct 2026
--
-- Adam, 27 Oct: "the org chart on the website should show me all users for all labs". Until now a
-- profile was readable only by people sharing a lab with it (013), so Adam saw his own lab and
-- nobody in Cole's, Singh's, Park's or Chahla's once they had their own. This adds one branch:
-- the app admin (app_admins — Adam alone since 005) reads every profile row.
--
-- Profiles only: a name, email, role and reporting line. No study, task, note or meeting of another
-- lab becomes visible — those still need support access, which stays break-glass. Write policies
-- are untouched, so another lab's people are shown, not editable, from here.
--
-- ROLLBACK: restore "workspace read" from migration 015 (this file without the is_app_admin
-- profile branch).

drop policy if exists "workspace read" on public.items;
create policy "workspace read" on public.items for select to authenticated
using (
  kind = 'meeting'
  or public.has_support_access(workspace)
  or (
    workspace in (select public.my_workspaces())
    and (
      -- Studies: the lab's managers, or someone involved (011).
      (kind = 'study' and (public.sees_whole_lab(workspace) or public.is_involved(data) or public.assigned_on_study(id::text)))
      -- Forwarded meetings: managers, sender, recipients (015).
      or (kind = 'suggestion' and coalesce(data->>'source', '') = 'meeting' and public.can_see_meeting(workspace, data))
      -- Everything else in the lab, as before.
      or (kind <> 'study' and not (kind = 'suggestion' and coalesce(data->>'source', '') = 'meeting'))
    )
  )
  -- Named on it, wherever it lives (012).
  or (
    kind = 'study'
    and (public.is_collaborator(data) or public.assigned_on_study_strict(id::text))
  )
  -- It names the PI of a lab I manage (014).
  or (
    kind = 'study'
    and public.lab_pi_named(data)
  )
  -- The app admin sees every lab's people, for the org chart (this migration).
  or (kind = 'profile' and public.is_app_admin())
  -- Whoever shares a lab with me, whatever their own primary lab says (013).
  or (
    kind = 'profile'
    and exists (
      select 1 from public.lab_members lm
       where lm.user_id = items.id
         and lm.workspace in (select public.my_workspaces())
    )
  )
);

-- VERIFY — inside `begin; ... rollback;`:
--   a. Adam: every profile row; study, task and meeting counts unchanged.
--   b. Will (lab admin, not app admin): profile count unchanged.
