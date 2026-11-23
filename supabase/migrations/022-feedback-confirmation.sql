-- 022 — People confirm whether a fix worked (23 Nov 2026).
--
-- Adam: "a list … where they will get a notification (like a 1 or 2) meaning 1 or 2 items have been
-- addressed and they can confirm or deny in the system after we make change."
--
-- The person who filed a report can answer it once it's marked done: "works" or "still_broken".
-- Still broken reopens it (status 'reopened') with their note; the app then emails Adam through
-- feedback-alert. They can't touch anything else on the row — the UPDATE policy stays admin-only,
-- and this function is the only way in.
--
-- When Adam marks a reopened report done again, the old answer is cleared so they're asked again.
--
-- ROLLBACK: drop trigger feedback_reset_answer on public.feedback; drop function
-- public.feedback_reset_answer(); drop function public.answer_feedback(uuid, boolean, text);
-- alter table public.feedback drop column confirmation, drop column confirmed_at,
-- drop column confirmation_note;

alter table public.feedback
  add column if not exists confirmation text check (confirmation in ('works', 'still_broken')),
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmation_note text;

create or replace function public.answer_feedback(p_id uuid, p_works boolean, p_note text default '')
returns text
language plpgsql security definer
set search_path to 'public'
as $$
declare r public.feedback%rowtype;
begin
  select * into r from public.feedback where id = p_id;
  if not found then raise exception 'That report no longer exists'; end if;
  if r.author_id is distinct from auth.uid() then raise exception 'That isn''t your report'; end if;
  if r.status <> 'done' then raise exception 'That report isn''t marked as fixed'; end if;
  update public.feedback
     set confirmation = case when p_works then 'works' else 'still_broken' end,
         confirmed_at = now(),
         confirmation_note = nullif(left(coalesce(p_note, ''), 2000), ''),
         status = case when p_works then status else 'reopened' end
   where id = p_id;
  return case when p_works then 'works' else 'reopened' end;
end $$;
revoke all on function public.answer_feedback(uuid, boolean, text) from public;
grant execute on function public.answer_feedback(uuid, boolean, text) to authenticated;

create or replace function public.feedback_reset_answer()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  if new.status = 'done' and old.status is distinct from 'done' then
    new.confirmation := null; new.confirmed_at := null;
  end if;
  return new;
end $$;
drop trigger if exists feedback_reset_answer on public.feedback;
create trigger feedback_reset_answer before update on public.feedback
  for each row execute function public.feedback_reset_answer();
