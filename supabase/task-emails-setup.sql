-- ============================================================================
-- Task reminder emails — database setup
-- Run this ONCE in the Supabase SQL editor, after the task-emails edge function
-- is deployed and the SMTP_USER / SMTP_PASSWORD secrets are set in Edge Function secrets.
-- (Sending goes through Gmail SMTP, not a transactional API — Rush IT won't add the DNS
-- records a service like Resend requires for rushortho.com.)
-- ============================================================================

-- 1. Record of what we've already emailed.
--    The unique constraint is the whole de-duplication mechanism: the sweep tries to insert
--    a row before sending, and a conflict means "already nudged, skip it". Deliberately NOT
--    in the `items` table — the app pulls every row of `items` on load, so log rows there
--    would sync junk to every device.
create table if not exists email_log (
  id         bigserial primary key,
  task_id    text        not null,
  recipient  text        not null,
  kind       text        not null,   -- 'assigned' | 'due_soon' | 'overdue'
  sent_at    timestamptz not null default now(),
  constraint email_log_once unique (task_id, recipient, kind)
);

-- Only the service role (used by the edge function) touches this. No client access at all.
alter table email_log enable row level security;

-- If a task's due date moves later, its old "due_soon"/"overdue" rows should clear so the
-- new date can trigger a fresh reminder. Assignment emails are never resent.
create or replace function reset_email_log_on_due_change() returns trigger as $$
begin
  if new.kind = 'task'
     and coalesce(new.data->>'due','') is distinct from coalesce(old.data->>'due','') then
    delete from email_log
     where task_id = new.data->>'id'
       and kind in ('due_soon','overdue');
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists items_due_change on items;
create trigger items_due_change
  after update on items
  for each row execute function reset_email_log_on_due_change();

-- 2. Scheduled sweep for due-soon and overdue tasks.
--    Runs every weekday at 7am America/Chicago (13:00 UTC). Nobody gets an email unless they
--    actually have something newly due or overdue, so this is quiet by default.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replace <PROJECT_REF> and <SERVICE_ROLE_KEY> before running.
select cron.unschedule('task-email-sweep') where exists (
  select 1 from cron.job where jobname = 'task-email-sweep'
);
select cron.schedule(
  'task-email-sweep',
  '0 13 * * 1-5',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/task-emails',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
               ),
    body    := jsonb_build_object('mode','sweep')
  );
  $$
);

-- 3. Instant "you've been assigned a task" email.
--    The dashboard's Database Webhooks feature isn't enabled on this project (no
--    `supabase_functions` schema), so this is the same thing written by hand on top of
--    pg_net. It also filters harder than the dashboard version can: the mailer is only
--    woken when a TASK row changes AND its assignee list actually differs, so the app's
--    routine study/meeting syncing costs nothing.
--
--    The auth key is read out of the sweep cron job above rather than pasted again, which
--    keeps the service role key in exactly one place.
create or replace function notify_task_assignment() returns trigger
language plpgsql security definer as $fn$
declare k text; u text;
begin
  if new.kind <> 'task' then return new; end if;
  if coalesce(new.data->>'done','false') = 'true' then return new; end if;
  if tg_op = 'UPDATE'
     and (new.data->'assignees') is not distinct from (old.data->'assignees') then
    return new;
  end if;

  select substring(command from 'Bearer ([^'']+)'),
         substring(command from 'url\s*:=\s*''([^'']+)''')
    into k, u
    from cron.job where jobname = 'task-email-sweep';
  if k is null or u is null then return new; end if;

  perform net.http_post(
    url     := u,
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || k
               ),
    body    := jsonb_build_object(
                 'type',       tg_op,
                 'table',      tg_table_name,
                 'record',     to_jsonb(new),
                 'old_record', case when tg_op = 'UPDATE' then to_jsonb(old) else null end
               )
  );
  return new;
end;
$fn$;

drop trigger if exists items_assignment_email on items;
create trigger items_assignment_email
  after insert or update on items
  for each row execute function notify_task_assignment();

-- ---------------------------------------------------------------------------
-- Useful checks afterwards:
--   select * from cron.job;                        -- is the sweep scheduled?
--   select * from email_log order by sent_at desc; -- what has gone out?
--   delete from email_log;                         -- resend everything (testing only)
--
--   -- Did the trigger's POST reach the function? pg_net dispatches AFTER commit, so if you
--   -- test inside a DO block this stays empty until the block finishes — re-run the select.
--   select status_code, content, created
--     from net._http_response
--    where created > now() - interval '10 minutes'
--    order by created desc;
-- ---------------------------------------------------------------------------
