-- Sections, and coverage.   19 Oct 2026
--
-- These are two different things, and the first draft of this migration wrongly made them one.
--
--   A SECTION is what part of the department you're in — Sports, Spine, Trauma. Adam is in
--   Sports. So are Chahla and Cole. It is a label: it groups labs and people, it's what a new
--   lab is asked on joining, and it grants NOTHING. Adam being in Sports must not let him see
--   Chahla's studies; his standing instruction is that he should not have access to other PIs'
--   studies at all, and a section that quietly conferred access would be a side door around it.
--
--   COVERAGE is "Carla looks after all of Sports". It is a deliberate grant to a named person,
--   it expands into every lab in that section including labs added later, and it carries the
--   same rights as membership of each of those labs — read, update, insert, delete — because
--   she is doing the work, and coverage that can see a problem without fixing it is not
--   coverage.
--
-- Keeping them apart is the whole point. One person being in a section tells you nothing about
-- what they can see; only a row in division_coverage does.
--
-- A person's own section lives on their profile row (`data.division`) rather than in a table
-- here: it is pure description with no access consequence, so it belongs with the rest of their
-- details and needs no policy of its own.
--
-- This migration does not make anybody an admin. is_app_admin() and is_lab_admin() are untouched,
-- so covering a lab never means being able to invite people into it or change its settings.
--
-- ROLLBACK: `drop function public.my_division_workspaces() cascade;` then restore my_workspaces()
-- to the two-branch union in migration 008. The tables can stay — they grant nothing on their
-- own, because only my_workspaces() reads them. No row in `items` is touched by this migration.

-- 1. Sections ---------------------------------------------------------------------------------
create table if not exists public.divisions (
  key        text primary key,
  name       text not null,
  created_at timestamptz not null default now()
);

-- Which section a lab is in. Descriptive. A lab in no section is fine and is the default.
-- Deliberately not unique on workspace alone: a lab could sit in two sections one day, and
-- nothing here depends on it sitting in only one.
create table if not exists public.lab_divisions (
  workspace text not null,
  division  text not null references public.divisions(key) on delete cascade,
  added_at  timestamptz not null default now(),
  primary key (workspace, division)
);
create index if not exists lab_divisions_division_idx on public.lab_divisions (division);

-- Who COVERS a section. Named for what it does, so that nobody later reads "members" and assumes
-- it is the same list as "people in Sports". It is not: Adam is in Sports and is not in here.
create table if not exists public.division_coverage (
  user_id  uuid not null,
  division text not null references public.divisions(key) on delete cascade,
  -- For the day somebody asks why this person can see that lab.
  note     text not null default '',
  added_at timestamptz not null default now(),
  primary key (user_id, division)
);
create index if not exists division_coverage_user_idx on public.division_coverage (user_id);

-- 2. Row-level security ------------------------------------------------------------------------
-- Readable by anyone signed in, because the app has to know what it may show and the shape of
-- the department is not itself sensitive. Writable only by an app admin: these tables decide who
-- sees what. A lab admin who could put their own lab in a section that somebody covers would be
-- handing their studies to that person, and one who could add themselves to coverage would be
-- taking everyone else's.
alter table public.divisions         enable row level security;
alter table public.lab_divisions     enable row level security;
alter table public.division_coverage enable row level security;

drop policy if exists divisions_read on public.divisions;
create policy divisions_read on public.divisions for select to authenticated using (true);
drop policy if exists divisions_write on public.divisions;
create policy divisions_write on public.divisions for all to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());

drop policy if exists lab_divisions_read on public.lab_divisions;
create policy lab_divisions_read on public.lab_divisions for select to authenticated using (true);
drop policy if exists lab_divisions_write on public.lab_divisions;
create policy lab_divisions_write on public.lab_divisions for all to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());

drop policy if exists division_coverage_read on public.division_coverage;
create policy division_coverage_read on public.division_coverage for select to authenticated using (true);
drop policy if exists division_coverage_write on public.division_coverage;
create policy division_coverage_write on public.division_coverage for all to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());

-- 3. The expansion -------------------------------------------------------------------------------
-- Reads COVERAGE, never section membership. This one-line distinction is the security boundary
-- between "Adam is in Sports" and "Adam can see Sports".
--
-- SECURITY DEFINER for the same reason as the rest: this is read from inside a policy, and a
-- policy that had to pass a policy in order to decide anything would return nothing.
create or replace function public.my_division_workspaces()
returns setof text language sql stable security definer set search_path = public as $$
  select ld.workspace
    from public.division_coverage dc
    join public.lab_divisions ld on ld.division = dc.division
   where dc.user_id = auth.uid()
$$;
revoke all on function public.my_division_workspaces() from public;
grant execute on function public.my_division_workspaces() to authenticated;

-- my_workspaces() gains a third branch. The first two are unchanged, so anyone who covers nothing
-- gets exactly what they got before — which, on the day this runs, is everybody.
create or replace function public.my_workspaces()
returns setof text language sql stable security definer set search_path = public as $$
  select workspace from public.lab_members where user_id = auth.uid()
  union
  select coalesce(
    (select i.workspace from public.items i
      where i.kind = 'profile' and i.id = auth.uid() limit 1),
    'sports-yanke')
  union
  select * from public.my_division_workspaces()
$$;

-- 4. Sports exists, and the lab that exists is in it ----------------------------------------------
-- No coverage rows. Adding Carla is a separate, deliberate step once the VERIFY block passes.
insert into public.divisions (key, name) values ('sports', 'Sports Medicine')
  on conflict (key) do nothing;
insert into public.lab_divisions (workspace, division) values ('sports-yanke', 'sports')
  on conflict (workspace, division) do nothing;

-- VERIFY — run each inside `begin; ... rollback;` as the real user, never as service role, which
-- bypasses RLS and would pass regardless.
--
--   a. Before any coverage row exists, my_workspaces() is unchanged for every user.
--   b. Adam is in Sports (lab_divisions) and still sees ONLY sports-yanke. This is the one that
--      matters: being in a section must confer nothing.
--   c. Adding Carla to division_coverage('sports') gives her every lab in Sports and nothing else.
--   d. Adding a second lab to Sports adds it to Carla's set without touching her profile row.
--   e. A lab in no section is invisible to her.
--   f. She is still not is_app_admin() and still not is_lab_admin() anywhere.
--   g. A lab admin cannot insert into lab_divisions or division_coverage (policy denies).
