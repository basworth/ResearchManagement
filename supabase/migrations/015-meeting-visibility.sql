-- A forwarded meeting is seen by the lab's managers, its sender and its recipients only.   27 Oct 2026
--
-- Adam, 27 Oct, asked who could see a meeting card. The answer was everyone in the lab: a
-- suggestion row is a non-study row, and since 011 non-study rows (tasks, notes, suggestions) are
-- open to the whole lab. So an RA saw every item about every study in the meeting, and the full
-- transcript behind "Show the meeting", including studies they're not on — wider than the study
-- rule itself. He chose: "Admins + sender + recipients".
--
-- WHO SEES A MEETING ROW (data.source = 'meeting'):
--   * whoever manages the lab it's in: lab admin of it, section coverage, app admin
--     (sees_whole_lab, the same test that gives them every study)
--   * whoever forwarded it (data.forwardedBy)
--   * everyone the summary email went to (data.repliedTo / data.copied), matched on the sign-in
--     address or the profile's alert address
-- Support access still shows it, as it shows everything (break-glass, logged, bannered).
--
-- Only meeting rows change. Journal-email suggestions, tasks, notes and every other non-study row
-- read exactly as before. Write policies are untouched — this is about what people can see.
--
-- ROLLBACK: restore "workspace read" from migration 014. can_see_meeting() can stay.

create or replace function public.can_see_meeting(ws text, d jsonb)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select public.sees_whole_lab(ws)
      or coalesce(d->>'forwardedBy', '') = coalesce(auth.uid()::text, '-')
      or exists (
        select 1
          from jsonb_array_elements_text(
                 coalesce(case when jsonb_typeof(d->'repliedTo') = 'array' then d->'repliedTo' end, '[]'::jsonb)
                 || coalesce(case when jsonb_typeof(d->'copied') = 'array' then d->'copied' end, '[]'::jsonb)) r
         where lower(trim(r)) <> ''
           and (lower(trim(r)) = lower(coalesce(auth.jwt()->>'email', ''))
                or lower(trim(r)) = (select lower(coalesce(p.data->>'alertEmail', '')) from public.items p
                                       where p.kind = 'profile' and p.id = auth.uid() limit 1))
      )
$$;
revoke all on function public.can_see_meeting(text, jsonb) from public;
grant execute on function public.can_see_meeting(text, jsonb) to authenticated;

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
      -- Forwarded meetings: managers, sender, recipients (this migration).
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

-- VERIFY — inside `begin; ... rollback;`, as real users:
--   a. An RA in sports-yanke who neither sent nor received the 26 Oct meeting: 0 meeting rows;
--      tasks, notes and journal-email suggestions unchanged.
--   b. Will (lab admin): every meeting row. Adam (sender): his. A recipient: theirs.
--   c. Study counts unchanged for everyone.
