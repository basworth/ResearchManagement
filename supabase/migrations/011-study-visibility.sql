-- Studies become visible by involvement, not by lab membership.   19 Oct 2026
--
-- Until now, being in a lab meant reading every row in it. All thirteen non-admins in
-- sports-yanke could open all 397 studies, including an RA who joined last month and a paper from
-- 2015. Adam's rule is narrower: an RA sees what they're involved in; his lab admins (Will, TJ)
-- see everything of his; and anyone covering the section (Carla) sees everything in it.
--
-- WHAT COUNTS AS INVOLVED, and why each one is here:
--   * named in the study's Team           — the explicit answer
--   * named as PI                         — a PI is on their own work by definition
--   * in the study's author list          — 276 of 397 studies are publications whose only link
--                                           to a person is the author list; without this, people
--                                           lose papers they wrote
--   * in the publication's author list    — the same list in its other home. A first draft of the
--                                           dry run read only one of these two fields and
--                                           understated everyone's access by roughly two thirds.
--   * assigned a task on it               — doing the work counts even if nobody added you to Team
--
-- ONLY STUDIES ARE NARROWED. Tasks, notes, meetings, profiles, the roster, filter sets and
-- suggestions are untouched. Narrowing those would break the app in ways that look like data loss:
-- a task whose study you cannot read still has to appear in your own task list.
--
-- NOBODY IS GRANDFATHERED. A person with no involvement sees no studies, including somebody brand
-- new. The alternative — "if you match nothing, see everything" — would hand a new RA all 397 on
-- their first day, which is the opposite of the point.
--
-- WHAT THIS DOES NOT CHANGE: insert, update and delete. Someone who can reach a study can still
-- edit it. This migration is about what you can SEE. Narrowing writes as well would be a second,
-- separate decision with its own failure modes.
--
-- MEASURED BEFORE APPLYING, against live data: Chahla 66 of 397, Haneberg 34, Sachdev 33,
-- Amin 29, Oppenheim 22, Acheampong 20, Augustin 16, Phillips 16, Yuh 10, Hakimiyan 9,
-- Roberts 6, Shinn 5, Haboba 3. Admins (Adam, Will, TJ, Carla) keep all 397.
--
-- ROLLBACK: restore the "workspace read" policy from migration 009's state — that is, the version
-- in 008 with no involvement test:
--   create policy "workspace read" on public.items for select to authenticated
--   using ( workspace in (select public.my_workspaces()) or kind = 'meeting'
--        or public.has_support_access(workspace) );
-- The functions below can stay; they grant nothing on their own. No row is modified here.

-- 1. Who am I, by name ---------------------------------------------------------------------------
-- Studies record people as display names, not ids, so the match has to go through the name on the
-- caller's profile. Surname alone is included because author lists frequently carry only that.
--
-- This is the weak joint in the whole design: a person whose profile name doesn't match how they
-- are written on a study silently loses that study. It is why the name reconciliation was done
-- first, and why the dry-run report exists.
create or replace function public.my_names()
returns text[] language sql stable security definer set search_path = public as $$
  with me as (
    select lower(trim(i.data->>'name')) as n
      from public.items i
     where i.kind = 'profile' and i.id = auth.uid()
     limit 1
  )
  select coalesce(array(
    select distinct x from (
      select n as x from me where n is not null and n <> ''
      union all
      select split_part(n, ' ', array_length(string_to_array(n, ' '), 1))
        from me
       where n is not null and n <> '' and position(' ' in n) > 0
      union all
      -- Every name that was merged INTO this one by the roster reconciliation. Anu Hakimiyan is
      -- written "Anu" on two studies and "Arnavaz(Anu) Hakimiyan" on her profile; without this she
      -- silently loses both. Caught by comparing the shipped matcher against the approved dry-run
      -- counts — they differed by exactly two, for exactly one person.
      select lower(trim(kv.key))
        from public.items m,
             lateral jsonb_each_text(
               case when jsonb_typeof(m.data->'nameAliases') = 'object'
                    then m.data->'nameAliases' else '{}'::jsonb end) kv
       where m.kind = 'meta'
         and m.workspace in (select public.my_workspaces())
         and lower(trim(kv.value)) = (select n from me)
    ) t
    where x is not null and length(x) > 2   -- a two-letter "surname" would match far too much
  ), '{}'::text[])
$$;
revoke all on function public.my_names() from public;
grant execute on function public.my_names() to authenticated;

-- 2. Am I on this study? --------------------------------------------------------------------------
-- Every field is read defensively. `team` has been a string in old rows and an array in new ones,
-- and jsonb_array_elements on the wrong type raises rather than returning nothing — which inside a
-- policy would mean the row simply vanishes for everyone, with no error anybody would ever see.
create or replace function public.is_involved(d jsonb)
returns boolean language sql stable security definer set search_path = public as $$
  with names as (select unnest(public.my_names()) as n),
  hay as (
    select lower(trim(v)) as h
      from jsonb_array_elements_text(
             case when jsonb_typeof(d->'team') = 'array' then d->'team' else '[]'::jsonb end) v
    union all
    select lower(trim(d->>'team'))
     where jsonb_typeof(d->'team') = 'string'
    union all
    select lower(trim(d->>'pi'))
    union all
    select lower(trim(concat_ws(' ', a->>'fore', a->>'last')))
      from jsonb_array_elements(
             case when jsonb_typeof(d->'authors') = 'array' then d->'authors' else '[]'::jsonb end) a
     where jsonb_typeof(a) = 'object'
    union all
    select lower(trim(a #>> '{}'))
      from jsonb_array_elements(
             case when jsonb_typeof(d->'authors') = 'array' then d->'authors' else '[]'::jsonb end) a
     where jsonb_typeof(a) = 'string'
    union all
    select lower(trim(concat_ws(' ', a->>'fore', a->>'last')))
      from jsonb_array_elements(
             case when jsonb_typeof(d->'publication'->'authors') = 'array'
                  then d->'publication'->'authors' else '[]'::jsonb end) a
     where jsonb_typeof(a) = 'object'
    union all
    select lower(trim(d->'publication'->>'authorList'))
  )
  select exists (
    select 1 from hay, names
     where hay.h is not null and hay.h <> ''
       and position(names.n in hay.h) > 0
  )
$$;
revoke all on function public.is_involved(jsonb) from public;
grant execute on function public.is_involved(jsonb) to authenticated;

-- 3. Am I assigned a task on it? -------------------------------------------------------------------
-- Doing the work counts even when nobody remembered to add you to the Team.
create or replace function public.assigned_on_study(study_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.items t,
           lateral jsonb_array_elements_text(
             case when jsonb_typeof(t.data->'assignees') = 'array'
                  then t.data->'assignees' else '[]'::jsonb end) a,
           lateral unnest(public.my_names()) n
     where t.kind = 'task'
       and t.data->>'studyId' = study_id
       and position(n in lower(trim(a))) > 0
  )
$$;
revoke all on function public.assigned_on_study(text) from public;
grant execute on function public.assigned_on_study(text) to authenticated;

-- 4. Do I see everything in this lab? ----------------------------------------------------------------
-- Three ways, and all three are deliberate:
--   app admin        — Adam, and anyone he has made one
--   lab admin here   — Will and TJ in sports-yanke; a PI's own senior staff
--   section coverage — Carla. She covers Sports, so she sees every lab in Sports in full. This is
--                      the branch that keeps her unaffected by everything above.
create or replace function public.sees_whole_lab(ws text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_app_admin()
      or (public.is_lab_admin() and ws = public.my_workspace())
      or exists (select 1 from public.my_division_workspaces() w where w = ws)
$$;
revoke all on function public.sees_whole_lab(text) from public;
grant execute on function public.sees_whole_lab(text) to authenticated;

-- 5. The policy ---------------------------------------------------------------------------------------
-- Note the shape: everything that is not a study is unchanged. The involvement test applies to
-- kind = 'study' and nothing else.
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
);

-- VERIFY — each inside `begin; ... rollback;`, as real users, never as service role.
--
--   a. Adam sees 397 studies.
--   b. Will and TJ see 397 (lab admins of sports-yanke).
--   c. Carla sees 397 — via coverage, NOT via being an app admin. Check by temporarily removing
--      her app_admins row inside the transaction: she must still see all 397.
--   d. Chahla sees 66. Haneberg 34. Haboba 3. These must match the dry run exactly; a different
--      number means the SQL and the simulation disagree and one of them is wrong.
--   e. Every non-admin still sees every TASK they are assigned, including tasks on studies they
--      cannot read.
--   f. Every non-admin still sees their own profile, the roster, meetings and filter sets.
--   g. A profile with a NULL or empty name sees zero studies and does not error.
--   h. Nobody's study count went UP.
