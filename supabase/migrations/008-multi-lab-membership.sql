-- Lab membership becomes a set.   19 Oct 2026
--
-- Until now a person belonged to exactly one lab: `my_workspace()` returned a single string and
-- every policy compared it with `=`. That cannot express "Carla covers all of Sports", and with
-- labs about to be one-per-PI, cross-lab staff are the normal case rather than the exception.
--
-- This is the load-bearing change — divisions (009) and per-study sharing (010) both sit on top
-- of it. Nothing here grants anyone access they did not already have: the membership table is
-- seeded from the workspace already on each profile, and `my_workspaces()` keeps that profile
-- value as a fallback, so the first run is a strict no-op.
--
-- ROLLBACK: restore the four `items` policies and the support_grants policy to compare against
-- my_workspace() with `=`. The function is still defined and still returns the primary lab, so
-- the old definitions work unchanged. Nothing is dropped and no row is modified.

-- 1. Membership ---------------------------------------------------------------------------
create table if not exists public.lab_members (
  user_id   uuid not null,
  workspace text not null,
  -- How they got in, for the day someone asks why a person can see a lab. 'profile' means
  -- seeded from their original single workspace; 'granted' means added deliberately.
  source    text not null default 'granted',
  added_at  timestamptz not null default now(),
  primary key (user_id, workspace)
);
create index if not exists lab_members_user_idx on public.lab_members (user_id);

alter table public.lab_members enable row level security;
-- Readable by anyone signed in: the app needs to know which labs it may show, and membership is
-- not itself sensitive. Writable only by an app admin — this is the table that decides who sees
-- what, so a lab admin must not be able to add themselves to another lab.
drop policy if exists lab_members_read on public.lab_members;
create policy lab_members_read on public.lab_members for select to authenticated using (true);
drop policy if exists lab_members_write on public.lab_members;
create policy lab_members_write on public.lab_members for all to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());

-- 2. Seed it from what each profile already says, so day one changes nothing ----------------
insert into public.lab_members (user_id, workspace, source)
select i.id, i.workspace, 'profile'
  from public.items i
 where i.kind = 'profile' and i.workspace is not null
on conflict (user_id, workspace) do nothing;

-- 3. The set, replacing the single value ----------------------------------------------------
-- SECURITY DEFINER for the same reason my_workspace() was: a policy that had to read a row in
-- order to decide whether it may read rows would never return anything.
--
-- The union with the profile value is deliberate belt-and-braces. If the seed above ever misses
-- somebody — a profile created after this ran, say — they still reach their own lab instead of
-- being locked out of everything, which is the failure that would be hardest to diagnose.
create or replace function public.my_workspaces()
returns setof text language sql stable security definer set search_path = public as $$
  select workspace from public.lab_members where user_id = auth.uid()
  union
  select coalesce(
    (select i.workspace from public.items i
      where i.kind = 'profile' and i.id = auth.uid() limit 1),
    'sports-yanke')
$$;
revoke all on function public.my_workspaces() from public;
grant execute on function public.my_workspaces() to authenticated;

-- my_workspace() stays, meaning "the lab I primarily belong to" — the one on my profile. It is
-- what a NEW record is stamped with, and what the app shows as "your lab".
create or replace function public.my_workspace()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select i.workspace from public.items i
      where i.kind = 'profile' and i.id = auth.uid() limit 1),
    'sports-yanke')
$$;

-- 4. Every policy moves from `=` to `in` -----------------------------------------------------
drop policy if exists "workspace read"   on public.items;
drop policy if exists "workspace insert" on public.items;
drop policy if exists "workspace update" on public.items;
drop policy if exists "workspace delete" on public.items;

create policy "workspace read" on public.items for select to authenticated
using ( workspace in (select public.my_workspaces())
     or kind = 'meeting'
     or public.has_support_access(workspace) );

-- Insert stays narrower than read on purpose: you may only CREATE a record in a lab you belong
-- to, never in one you merely have support access to. Support is for fixing, not for authoring.
create policy "workspace insert" on public.items for insert to authenticated
with check ( workspace in (select public.my_workspaces()) or kind = 'meeting' );

create policy "workspace update" on public.items for update to authenticated
using  ( workspace in (select public.my_workspaces()) or kind = 'meeting' or public.has_support_access(workspace) )
with check ( workspace in (select public.my_workspaces()) or kind = 'meeting' or public.has_support_access(workspace) );

create policy "workspace delete" on public.items for delete to authenticated
using ( workspace in (select public.my_workspaces()) or kind = 'meeting' or public.has_support_access(workspace) );

-- Support grants: you see grants about you, or over any lab you are in.
drop policy if exists "see grants about me or my lab" on public.support_grants;
create policy "see grants about me or my lab" on public.support_grants for select to authenticated
using (grantee = auth.uid() or workspace in (select public.my_workspaces()));

-- VERIFIED after applying, each inside a rolled-back transaction ------------------------------
--   (filled in from the session once run)
