-- Collaborators see a study wherever it lives.   19 Oct 2026
--
-- A study carries one lab label and keeps it forever. Reading it has, until now, required being a
-- member of THAT lab — the label is checked before anyone looks at who is on the study. So the
-- moment Chahla has his own lab, a study of his that Adam is an investigator on is invisible to
-- Adam. Adam's words: "when we have someone in the other lab, like a Chahla study that he adds
-- me to, I can see as well."
--
-- This adds a second, narrower door: if you are named on a study, you can read it regardless of
-- which lab it belongs to.
--
-- THE CROSS-LAB TEST IS DELIBERATELY STRICTER THAN THE INSIDE-A-LAB ONE:
--
--   * Full name only. Inside your own lab a surname match is a convenience — the author lists say
--     "Haboba C" and that is obviously her. Across a lab boundary the same looseness is a leak:
--     "Cole" would match Brian Cole in somebody else's lab, and more to the point two different
--     Coles would match each other. So cross-lab matching uses the whole name and nothing else.
--
--   * Team, PI and task assignment only — NOT the author list. Inside a lab, co-authorship on a
--     published paper grants access, and Adam has looked at what that does and accepted it: it is
--     why Cole reaches 186 of 397 in Adam's lab. Carrying that across labs would mean a new lab's
--     entire published back-catalogue became visible to every co-author elsewhere on the day it
--     was created. Collaboration means being put on the work, not having been credited once.
--
-- So: Chahla adds Adam to the Team of a sports-chahla study, and Adam sees that study. Chahla's
-- forty published papers that Adam happens to co-author stay in Chahla's lab.
--
-- WHAT THIS DOES NOT GRANT: insert or delete. A collaborator can read and update the study — the
-- update policy already requires the lab, so in practice they get read. Widening writes across a
-- lab boundary is a separate decision and is not taken here.
--
-- ROLLBACK: restore the "workspace read" policy from migration 011 — that is, this one without
-- the final `or (kind = 'study' and public.is_collaborator(data))` branch. The function can stay;
-- it grants nothing on its own. No row is modified by this migration.

-- 1. My full name, and only my full name ---------------------------------------------------------
-- Separate from my_names() on purpose. my_names() includes the surname and roster aliases, which
-- is right inside a lab and wrong across one. Keeping them as two functions means a future change
-- to the loose matcher cannot silently loosen the strict one.
create or replace function public.my_full_name()
returns text language sql stable security definer set search_path = public as $$
  select lower(trim(i.data->>'name'))
    from public.items i
   where i.kind = 'profile' and i.id = auth.uid()
   limit 1
$$;
revoke all on function public.my_full_name() from public;
grant execute on function public.my_full_name() to authenticated;

-- 2. Am I named on this study, strictly? -----------------------------------------------------------
-- Equality, not substring: "adam yanke" must equal the entry, so that a longer string containing
-- it cannot let someone in. A null or empty name matches nothing, which is the whole point —
-- a blank name must never behave like a wildcard.
create or replace function public.is_collaborator(d jsonb)
returns boolean language sql stable security definer set search_path = public as $$
  with me as (select public.my_full_name() as n)
  select case
    when (select n from me) is null or (select n from me) = '' then false
    else exists (
      select 1
        from jsonb_array_elements_text(
               case when jsonb_typeof(d->'team') = 'array' then d->'team' else '[]'::jsonb end) v
       where lower(trim(v)) = (select n from me)
    )
    or lower(trim(coalesce(d->>'pi', ''))) = (select n from me)
  end
$$;
revoke all on function public.is_collaborator(jsonb) from public;
grant execute on function public.is_collaborator(jsonb) to authenticated;

-- 3. Am I assigned a task on it, from anywhere? ------------------------------------------------------
-- Same strict rule. assigned_on_study() from 011 uses my_names() and is for inside a lab; this is
-- its cross-lab twin.
create or replace function public.assigned_on_study_strict(study_id text)
returns boolean language sql stable security definer set search_path = public as $$
  with me as (select public.my_full_name() as n)
  select case
    when (select n from me) is null or (select n from me) = '' then false
    else exists (
      select 1
        from public.items t,
             lateral jsonb_array_elements_text(
               case when jsonb_typeof(t.data->'assignees') = 'array'
                    then t.data->'assignees' else '[]'::jsonb end) a
       where t.kind = 'task'
         and t.data->>'studyId' = study_id
         and lower(trim(a)) = (select n from me)
    )
  end
$$;
revoke all on function public.assigned_on_study_strict(text) from public;
grant execute on function public.assigned_on_study_strict(text) to authenticated;

-- 4. The policy ----------------------------------------------------------------------------------------
-- Identical to 011 except for the last branch. Everything inside your own lab behaves exactly as
-- it did; the new door only ever adds rows, never removes them.
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
  -- Named on it, wherever it lives.
  or (
    kind = 'study'
    and (public.is_collaborator(data) or public.assigned_on_study_strict(id::text))
  )
);

-- VERIFY — each inside `begin; ... rollback;`, as real users, never as service role.
--
--   a. Nobody's count goes DOWN. This migration only adds a branch.
--   b. With only one lab in existence, nobody's count changes at all — every study is already in
--      a lab they belong to. Run before creating sports-chahla and confirm the thirteen numbers
--      are unchanged from 011.
--   c. Create a study in a second lab with Adam on the Team: Adam reads it; nobody else in his lab
--      does.
--   d. The same study with Adam only in its author list, NOT on the Team: Adam does NOT read it.
--      This is the author-credit exclusion, and it is the point of the migration.
--   e. A study in a second lab whose Team contains "Yanke" but not "Adam Yanke": Adam does NOT
--      read it. Surname alone must not cross a lab boundary.
--   f. A profile with a NULL or empty name reads nothing extra and does not error.
--   g. Insert and delete across labs are still refused.
