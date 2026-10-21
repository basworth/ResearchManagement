-- You can see the profile of anyone who shares a lab with you.   19 Oct 2026
--
-- A profile row carries the person's PRIMARY lab, and until now that label alone decided who
-- could read it. That was fine while everybody had exactly one lab. It stops being fine the
-- moment somebody's primary lab changes: Chahla is about to move to sports-chahla while staying
-- a member of sports-yanke, and under the old rule his profile would vanish from Adam's lab even
-- though he is still in it. The "My lab" list would show him as an unresolved id, the org chart
-- would lose him, and his name would stop resolving on the 66 studies he is on.
--
-- So profile visibility should follow MEMBERSHIP, not the label on the profile. If we are in a
-- lab together, I can see who you are.
--
-- This is a widening, and a small one: it exposes a name, email, position and reportsTo — the
-- same fields already visible to everyone in a shared lab today — to people who are in a lab with
-- that person but whose primary lab differs. It does not expose any study, task or note.
--
-- ROLLBACK: restore the "workspace read" policy from migration 012 — this one without the
-- `kind = 'profile' and shares a lab` branch. No row is modified here.

drop policy if exists "workspace read" on public.items;
create policy "workspace read" on public.items for select to authenticated
using (
  kind = 'meeting'
  or public.has_support_access(workspace)
  or (
    workspace in (select public.my_workspaces())
    and (
      kind <> 'study'
      or public.sees_whole_lab(workspace)
      or public.is_involved(data)
      or public.assigned_on_study(id::text)
    )
  )
  -- Named on it, wherever it lives (migration 012).
  or (
    kind = 'study'
    and (public.is_collaborator(data) or public.assigned_on_study_strict(id::text))
  )
  -- NEW: whoever shares a lab with me, whatever their own primary lab says.
  or (
    kind = 'profile'
    and exists (
      select 1 from public.lab_members lm
       where lm.user_id = items.id
         and lm.workspace in (select public.my_workspaces())
    )
  )
);

-- VERIFY — each inside `begin; ... rollback;`, as real users.
--
--   a. Before any profile moves: nobody's visible-profile count changes. Everyone's primary lab
--      is still the lab they are a member of, so the new branch adds nothing yet.
--   b. After moving a profile to another lab while keeping its lab_members row, that person is
--      still visible to the original lab.
--   c. Somebody in no shared lab is still invisible.
--   d. No study, task or note count changes — this branch is gated on kind = 'profile'.
