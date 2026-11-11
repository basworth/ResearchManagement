-- "Only the studies they're named on" — prior research team, lab technician, postdoc, trainees.   29 Oct 2026
--
-- Adam, 29 Oct: residents and fellows "would only be able to see studies that they are invited
-- to … they would only see stuff that they've been named on. Otherwise, they would see nothing
-- across the website." Then, person by person (all confirmed in chat before this was written):
--   prior research team (report to Adam, named studies only): Divesh Sachdev, Edouard Augustin,
--     Erik Haneberg, Jay Amin, Kofi Acheampong, Zachary Oppenheim
--   lab technician (research team, reports to Adam, named studies only): Anu Hakimiyan
--   postdoc (reports to no one, named studies only): Carolina Haboba
--   trainees (off the org chart, named studies only): Andrew Phillips, Austin Roberts, Daniel Shinn,
--     Nathan Varady (fellow), Matt Kingery (fellow, to be invited)
-- "Named on" keeps its definition: PI, Team, author list, or a task on the study (011/012).
--
-- WHO IS NAMED-ONLY: auth.users.raw_app_meta_data->>'access' = 'named'. app_metadata, not the
-- profile, because only the service role can write it — nobody can switch themselves back to
-- full lab view — and because it is there before a person's first sign-in (Nathan, Matt).
--
-- WHAT A NAMED-ONLY PERSON READS, in their own lab:
--   studies they're on · the tasks on those studies, and any task assigned to them · files attached
--   to those studies · their own profile and their own preferences · the lab's settings row (tag
--   lists, stage names — the app needs it to draw anything) · meeting summaries they sent or were
--   sent (015). Plus, as for everyone: the shared deadline calendar, and studies anywhere that
--   name them (012).
-- WHAT THEY NO LONGER READ: the lab's other tasks, meeting-note links, team list, suggestions,
-- saved views, research feed. Writes and deletes are held to the same set, so nothing can be
-- changed blind by id either.
--
-- ROLLBACK: restore the four "workspace …" policies from 016/014 (read: 016; insert/update: 014;
-- delete: the original). named_only() can stay; with no one flagged it changes nothing.

create or replace function public.named_only()
returns boolean
language sql stable security definer
set search_path to 'public', 'auth'
as $$
  select coalesce((select u.raw_app_meta_data->>'access' = 'named' from auth.users u where u.id = auth.uid()), false)
$$;

-- A study I'm on — the same tests the lab-member rule uses, by id.
create or replace function public.named_study_ok(sid text)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.items s
     where s.kind = 'study' and s.id::text = sid
       and (public.is_involved(s.data) or public.assigned_on_study(sid)
            or public.is_collaborator(s.data) or public.assigned_on_study_strict(sid))
  )
$$;

-- A task assigned to me by name (a task needn't belong to a study).
create or replace function public.task_is_mine(d jsonb)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1
      from jsonb_array_elements_text(case when jsonb_typeof(d->'assignees') = 'array' then d->'assignees' else '[]'::jsonb end) a,
           lateral unnest(public.my_names()) n
     where position(n in lower(trim(a))) > 0
  )
$$;

-- A file attached to a study I'm on (study.docs[], or an abstract's docs[]).
create or replace function public.file_on_my_study(fid uuid)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.items s
     where s.kind = 'study'
       and (jsonb_path_exists(s.data, '$.docs[*] ? (@.id == $f)', jsonb_build_object('f', fid::text))
            or jsonb_path_exists(s.data, '$.abstracts[*].docs[*] ? (@.id == $f)', jsonb_build_object('f', fid::text)))
       and public.named_study_ok(s.id::text)
  )
$$;

-- Everything a named-only person may touch in their own lab, for one row.
create or replace function public.named_row_ok(k text, rid uuid, d jsonb)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select case k
    when 'study'    then public.is_involved(d) or public.assigned_on_study(rid::text)
    when 'task'     then public.named_study_ok(coalesce(d->>'studyId', '')) or public.task_is_mine(d)
    when 'file'     then public.file_on_my_study(rid)
    when 'profile'  then rid = auth.uid()
    when 'userPref' then coalesce(d->>'id', '') = coalesce(auth.uid()::text, '-')
    when 'watchVote' then coalesce(d->>'userId', '') = coalesce(auth.uid()::text, '-')
    else false
  end
$$;

revoke all on function public.named_only() from public;
revoke all on function public.named_study_ok(text) from public;
revoke all on function public.task_is_mine(jsonb) from public;
revoke all on function public.file_on_my_study(uuid) from public;
revoke all on function public.named_row_ok(text, uuid, jsonb) from public;
grant execute on function public.named_only() to authenticated;
grant execute on function public.named_study_ok(text) to authenticated;
grant execute on function public.task_is_mine(jsonb) to authenticated;
grant execute on function public.file_on_my_study(uuid) to authenticated;
grant execute on function public.named_row_ok(text, uuid, jsonb) to authenticated;

drop policy if exists "workspace read" on public.items;
create policy "workspace read" on public.items for select to authenticated
using (
  kind = 'meeting'
  or public.has_support_access(workspace)
  or (
    workspace in (select public.my_workspaces())
    and not public.named_only()
    and (
      (kind = 'study' and (public.sees_whole_lab(workspace) or public.is_involved(data) or public.assigned_on_study(id::text)))
      or (kind = 'suggestion' and coalesce(data->>'source', '') = 'meeting' and public.can_see_meeting(workspace, data))
      or (kind <> 'study' and not (kind = 'suggestion' and coalesce(data->>'source', '') = 'meeting'))
    )
  )
  -- Named-only (this migration): just what's theirs, in their own lab.
  or (
    workspace in (select public.my_workspaces())
    and public.named_only()
    and (
      public.named_row_ok(kind, id, data)
      or kind = 'meta'
      or (kind = 'suggestion' and coalesce(data->>'source', '') = 'meeting' and public.can_see_meeting(workspace, data))
    )
  )
  or (kind = 'study' and (public.is_collaborator(data) or public.assigned_on_study_strict(id::text)))
  or (kind = 'study' and public.lab_pi_named(data))
  or (kind = 'profile' and public.is_app_admin())
  or (
    kind = 'profile'
    and not public.named_only()
    and exists (
      select 1 from public.lab_members lm
       where lm.user_id = items.id
         and lm.workspace in (select public.my_workspaces())
    )
  )
);

drop policy if exists "workspace update" on public.items;
create policy "workspace update" on public.items for update to authenticated
using (
  (workspace in (select public.my_workspaces()) and (not public.named_only() or public.named_row_ok(kind, id, data)))
  or kind = 'meeting'
  or public.has_support_access(workspace)
  or (kind = 'study' and public.lab_pi_named(data))
)
with check (
  (workspace in (select public.my_workspaces()) and (not public.named_only() or public.named_row_ok(kind, id, data)))
  or kind = 'meeting'
  or public.has_support_access(workspace)
  or (kind = 'study' and public.lab_pi_named(data) and public.study_stays_put(id, workspace))
);

drop policy if exists "workspace insert" on public.items;
create policy "workspace insert" on public.items for insert to authenticated
with check (
  -- A file row is written just before the study that lists it, so it can't be checked against
  -- that study yet; a named-only person may add files to their own lab, never read others'.
  (workspace in (select public.my_workspaces())
     and (not public.named_only() or kind = 'file' or public.named_row_ok(kind, id, data)))
  or kind = 'meeting'
  or (kind = 'study' and public.lab_pi_named(data) and public.study_stays_put(id, workspace))
);

drop policy if exists "workspace delete" on public.items;
create policy "workspace delete" on public.items for delete to authenticated
using (
  (workspace in (select public.my_workspaces()) and (not public.named_only() or public.named_row_ok(kind, id, data)))
  or kind = 'meeting'
  or public.has_support_access(workspace)
);

-- VERIFY — inside begin/rollback, flag the people above, then as each of Austin (trainee), Divesh
-- (prior team), Carolina (postdoc): study count = studies naming them; 0 lab tasks not on their
-- studies; 0 other profiles; 0 teamNotes / filterSets / non-meeting suggestions; can update one of
-- their studies, cannot update one they're not on. As Will and as Adam: counts unchanged.
