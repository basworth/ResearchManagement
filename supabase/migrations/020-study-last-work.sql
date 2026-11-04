-- When did a PERSON last work on each study?   4 Nov 2026
--
-- Adam: "why is almost nothing stale or rotten on my projects?" Freshness read the row's
-- updated_at, which every save moves: TJ's tag pass over ~40 studies (2 Nov), the bulk re-save of
-- 63 studies during lab setup (27 Oct), server-side fixes. 125 of 126 active studies looked
-- touched in the last fortnight; only 49 had a real edit by anyone since the history began.
--
-- This reads the change history (018) instead. A change counts when:
--   * a signed-in person made it (actor not null) — server writes are bulk fixes; meeting-email
--     updates are counted by the app from the meeting record, which knows they were real;
--   * on the study itself or one of its tasks (a task created, edited, ticked or removed);
--   * and at least one field really changed: not tags / tag suggestions, not an update request
--     (asking the team isn't the team working), and not a blank field being filled with an empty
--     default (null → "", [], {}, false), which the app does to old rows when they're saved.
--
-- SECURITY INVOKER: it reads audit_log under the caller's own rules, so it returns only studies
-- whose history the caller may already read.
-- ROLLBACK: drop function public.study_last_work(); the app falls back to updated_at.

create or replace function public.study_last_work()
returns table(study_id uuid, at timestamptz)
language sql stable security invoker
set search_path to 'public'
as $$
  select a.study_id, max(a.at)
    from public.audit_log a
   where a.study_id is not null
     and a.actor is not null
     and a.kind in ('study', 'task')
     and exists (
       select 1 from jsonb_each(a.changes) c(k, v)
        where c.k not in ('tags', 'tagSuggestion', 'updateRequests', 'docSlotsMigrated')
          and not (coalesce(c.v -> 'from', 'null'::jsonb) = 'null'::jsonb
                   and coalesce(c.v -> 'to', 'null'::jsonb) in ('null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb, 'false'::jsonb))
     )
   group by a.study_id
$$;
revoke all on function public.study_last_work() from public;
grant execute on function public.study_last_work() to authenticated;
