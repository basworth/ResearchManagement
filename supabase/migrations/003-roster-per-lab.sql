-- The roster stops being shared.   16 Oct 2026
--
-- 001 put 'meeting' and 'meta' in the commons together, on the reasoning that both were
-- department-wide. That was right about the deadline calendar and wrong about `meta`, which
-- carries the team roster, everyone's degrees, the name-alias map and the lab's initiation
-- checklist. A second lab would have opened the app to find the first lab's seventeen people in
-- its roster and its task-assignment pickers.
--
-- Worse than the visibility: there was exactly ONE meta row, and the app writes it whole. Two
-- labs editing their team lists would have taken turns deleting each other's.
--
-- The app now derives a row id per workspace (see metaRowId). The original lab keeps the id its
-- row has always had, so nothing moves and nothing is copied.
--
-- ROLLBACK, if the app is ever behind this: put 'meta' back in the four policies below. Nothing
-- here deletes or rewrites a row.

-- 1. meta leaves the commons ---------------------------------------------------------
drop policy if exists "workspace read"   on public.items;
drop policy if exists "workspace insert" on public.items;
drop policy if exists "workspace update" on public.items;
drop policy if exists "workspace delete" on public.items;

create policy "workspace read" on public.items for select to authenticated
using ( workspace = public.my_workspace()
     or kind = 'meeting'
     or public.has_support_access(workspace) );

create policy "workspace insert" on public.items for insert to authenticated
with check ( workspace = public.my_workspace() or kind = 'meeting' );

create policy "workspace update" on public.items for update to authenticated
using  ( workspace = public.my_workspace() or kind = 'meeting' or public.has_support_access(workspace) )
with check ( workspace = public.my_workspace() or kind = 'meeting' or public.has_support_access(workspace) );

create policy "workspace delete" on public.items for delete to authenticated
using ( workspace = public.my_workspace() or kind = 'meeting' or public.has_support_access(workspace) );

-- 2. Make sure the existing roster row is stamped ---------------------------------------
-- It was backfilled in 001 along with everything else, so this should be a no-op. Asserted
-- rather than assumed: if it were ever NULL, the row would match no policy at all and the whole
-- team would silently lose its roster, which reads exactly like the app forgetting everybody.
update public.items
   set workspace = 'sports-yanke'
 where kind = 'meta' and workspace is null;

-- VERIFIED after applying, each inside a rolled-back transaction -------------------------
--   as Adam:         1 meta row visible, the original one, with all 17 names
--   as a spine user: 0 meta rows visible, 40 meetings still visible
--   a spine user inserting a meta row stamped sports-yanke → refused
