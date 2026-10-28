-- Change history: who changed what, and when.   28 Oct 2026
--
-- Adam, 28 Oct: "can you keep an audit history of who changed what?" Until now items carried only
-- updated_at — the last time a row changed, never by whom — so "did anyone outside my lab edit
-- this?" had no answer.
--
-- HOW: an AFTER trigger on public.items writes one row per real change into public.audit_log:
--   * who: auth.uid() and the signed-in email; NULL actor = the server (the email / meeting reader,
--     or Adam's own SQL), which the app labels as such
--   * what: for an update, only the top-level fields that actually changed, each {from, to};
--     a create stores the new record, a delete the old one. A save that changes nothing (the app
--     re-saves whole records) writes nothing.
--   * which study: the study's own id, or data.studyId for a task/note on a study, so a study's
--     history includes its tasks.
-- AFTER, not BEFORE: an upsert onto an existing row fires the UPDATE triggers with the real OLD
-- (see the 9-day profile freeze), and AFTER INSERT only for genuinely new rows.
--
-- WHO CAN READ IT: anyone who can see the study can see that study's history (the subquery runs
-- under the reader's own row rules on items); the lab's managers see the whole lab's; app admin all.
-- Nobody can write, edit or delete it from the app — append-only, by the trigger alone.
--
-- Skipped: the research-watch feed rows (machine-written, large, and not anyone's edit).
--
-- ROLLBACK: drop trigger audit_items on public.items; the table can stay.

create table if not exists public.audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor       uuid,
  actor_email text,
  workspace   text,
  item_id     uuid,
  kind        text,
  study_id    uuid,
  action      text not null check (action in ('insert', 'update', 'delete')),
  changes     jsonb not null default '{}'::jsonb
);
create index if not exists audit_log_study_at on public.audit_log (study_id, at desc);
create index if not exists audit_log_ws_at on public.audit_log (workspace, at desc);
alter table public.audit_log enable row level security;

drop policy if exists "audit read" on public.audit_log;
create policy "audit read" on public.audit_log for select to authenticated
using (
  public.is_app_admin()
  or public.sees_whole_lab(workspace)
  or (study_id is not null and exists (select 1 from public.items i where i.id = audit_log.study_id))
);
-- No insert/update/delete policies: the table is written only by the trigger below.
revoke insert, update, delete on public.audit_log from authenticated, anon;

create or replace function public.audit_items()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $$
declare
  r  public.items;
  ch jsonb := '{}'::jsonb;
  k  text;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  if r.kind in ('watchFeed', 'watchConfig', 'watchVotes', 'watchKeeps') then return null; end if;

  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(coalesce(old.data, '{}'::jsonb) || coalesce(new.data, '{}'::jsonb)) loop
      if (old.data -> k) is distinct from (new.data -> k) then
        ch := ch || jsonb_build_object(k, jsonb_build_object('from', old.data -> k, 'to', new.data -> k));
      end if;
    end loop;
    if new.workspace is distinct from old.workspace then
      ch := ch || jsonb_build_object('_lab', jsonb_build_object('from', old.workspace, 'to', new.workspace));
    end if;
    if ch = '{}'::jsonb then return null; end if;
  elsif tg_op = 'INSERT' then
    ch := jsonb_build_object('_created', jsonb_build_object('to', new.data));
  else
    ch := jsonb_build_object('_deleted', jsonb_build_object('from', old.data));
  end if;

  insert into public.audit_log (actor, actor_email, workspace, item_id, kind, study_id, action, changes)
  values (auth.uid(), nullif(auth.jwt() ->> 'email', ''), r.workspace, r.id, r.kind,
          case when r.kind = 'study' then r.id
               when (r.data ->> 'studyId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               then (r.data ->> 'studyId')::uuid end,
          lower(tg_op), ch);
  return null;
end
$$;
revoke all on function public.audit_items() from public;

drop trigger if exists audit_items on public.items;
create trigger audit_items after insert or update or delete on public.items
  for each row execute function public.audit_items();

-- VERIFY — inside begin/rollback: as Will, change a study's phase → one audit row with
-- {phase: {from, to}}, actor = Will; re-save it unchanged → no new row; as an RA not on the study →
-- can't read its history; as Will → can read the lab's.
