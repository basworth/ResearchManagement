-- Run every lab's research feed weekly.
-- Paste into the Supabase SQL editor and press Run. Safe to run twice.
--
-- APPLY THIS LAST, after the research-watch function is deployed. A schedule pointing at a
-- function that does not exist fails quietly every Monday and nobody finds out until somebody
-- notices their feed is a month old.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replaced rather than duplicated, so running this twice leaves one job and not two.
select cron.unschedule(jobid) from cron.job where jobname = 'research-watch-weekly';

-- Monday 05:00 UTC - midnight Chicago, so a refreshed feed is waiting at the start of the week
-- rather than appearing underneath somebody mid-read.
select cron.schedule(
  'research-watch-weekly',
  '0 5 * * 1',
  $job$
  select net.http_post(
    url := 'https://wqgiqiqatdmoxpjbzxoj.supabase.co/functions/v1/research-watch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key', true)
    ),
    body := jsonb_build_object('windowDays', 30)
  );
  $job$
);

-- The key the job authenticates with. Set once, database-wide, and readable only by roles that
-- could already read everything.
-- REPLACE <SERVICE_ROLE_KEY> with the service_role key from
-- Project Settings -> API Keys, then run this line:
--
--   alter database postgres set app.service_role_key = '<SERVICE_ROLE_KEY>';
--
-- It takes effect on the next connection, so the first scheduled run is the test.

select jobname, schedule, active from cron.job where jobname = 'research-watch-weekly';
