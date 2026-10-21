-- Multi-lab workspaces, phase 1: the seal.   APPLIED 9 Oct 2026, 20:0x local.
--
-- Before this, `items` had exactly one rule — "authenticated team access", USING (true) — so any
-- signed-in account could read every row. Fine for one team; not isolation. This makes Postgres
-- itself refuse another lab's rows, so the boundary holds even for someone typing into a browser
-- console. The app's own filters (the Who picker, "my projects") stay what they always were:
-- convenience, not security.
--
-- Applied in four steps, deliberately ordered so the app and the rules are never out of step:
--   1. add the column and stamp all 369 existing rows 'sports-yanke'  (no behaviour change)
--   2. deploy the app that writes the stamp on every save              (commit c43e907)
--   3. create my_workspace(), support_grants, has_support_access()
--   4. swap the single permissive policy for the four below
-- Doing 1 and 2 before 4 is what removed the window where saves would have been refused.
--
-- ROLLBACK, if ever needed — one statement, and nothing has been destroyed:
--   drop policy "workspace read" on public.items;   -- and insert/update/delete
--   create policy "authenticated team access" on public.items for all to authenticated
--     using (true) with check (true);
-- A full pre-change snapshot is in public.items_backup_20261009 (369 rows, verified identical),
-- plus two JSON exports on Adam's machine.

-- 1. The stamp -----------------------------------------------------------------
alter table public.items add column if not exists workspace text;
update public.items set workspace = 'sports-yanke' where workspace is null;
create index if not exists items_workspace_idx on public.items (workspace);

comment on column public.items.workspace is
  'Owning lab, e.g. sports-yanke or spine-singh. Set on every write by the app; the policies below read it.';

-- 2. Which lab the signed-in person belongs to -----------------------------------
-- SECURITY DEFINER so the lookup isn't itself subject to the policies below — otherwise a policy
-- would need to read a row in order to decide whether it may read that row, and nobody would see
-- anything at all.
create or replace function public.my_workspace()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select i.workspace from public.items i where i.kind = 'profile' and i.id = auth.uid() limit 1),
    'sports-yanke')
$$;

-- 3. Break-glass support access ---------------------------------------------------
-- A row here is the only thing that opens the boundary. It expires on its own, it carries a stated
-- reason, and it is never deleted — deliberately a record rather than a flag somebody can quietly
-- switch back. The app shows the lab a banner naming who is in and why while one is live.
create table if not exists public.support_grants (
  id uuid primary key default gen_random_uuid(),
  grantee uuid not null,
  workspace text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz
);
create index if not exists support_grants_live_idx on public.support_grants (workspace, grantee, expires_at);

create or replace function public.has_support_access(target text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.support_grants g
    where g.grantee = auth.uid() and g.workspace = target
      and g.ended_at is null and g.expires_at > now())
$$;

-- 4. The policies ------------------------------------------------------------------
-- 'meeting' and 'meta' are the commons: one deadline calendar every lab shares, and the roster
-- row the biweekly refresh writes. Everything else is sealed to its own lab.
drop policy if exists "authenticated team access" on public.items;

create policy "workspace read" on public.items for select to authenticated
using ( workspace = public.my_workspace()
     or kind in ('meeting','meta')
     or public.has_support_access(workspace) );

create policy "workspace insert" on public.items for insert to authenticated
with check ( workspace = public.my_workspace() or kind in ('meeting','meta') );

create policy "workspace update" on public.items for update to authenticated
using  ( workspace = public.my_workspace() or kind in ('meeting','meta') or public.has_support_access(workspace) )
with check ( workspace = public.my_workspace() or kind in ('meeting','meta') or public.has_support_access(workspace) );

create policy "workspace delete" on public.items for delete to authenticated
using ( workspace = public.my_workspace() or kind in ('meeting','meta') or public.has_support_access(workspace) );

alter table public.support_grants enable row level security;
create policy "see grants about me or my lab" on public.support_grants for select to authenticated
using (grantee = auth.uid() or workspace = public.my_workspace());
create policy "only admins grant support access" on public.support_grants for insert to authenticated
with check (public.is_app_admin());
create policy "only admins end a grant" on public.support_grants for update to authenticated
using (public.is_app_admin());

-- VERIFIED after applying, each test inside a transaction that was rolled back ---------
--   as Adam (real user id): my_workspace = sports-yanke, 119 studies, 152 tasks, 369 rows   ✓ unchanged
--   as a spine user:        my_workspace = spine-singh,    0 studies,   0 tasks,  42 rows
--                           (40 shared deadlines + the meta row + his own profile)           ✓ sealed
--   Adam can still insert a study                                                            ✓
--   spine user inserting into sports-yanke → 42501 row-level security violation              ✓ refused
--   spine user updating Adam's studies     → 0 rows affected                                 ✓ refused
--   support grant: 0 spine studies visible before, 1 during, 0 once expired                  ✓ works and lapses
--   final state: 369 rows, 119 studies, 0 unstamped, 0 rows in any other lab, 0 grants issued
