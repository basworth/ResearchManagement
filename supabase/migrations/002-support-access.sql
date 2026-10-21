-- Support access, phase 2: making it usable and making it visible.   15 Oct 2026
--
-- 001 created `support_grants` and `has_support_access()`, which is the half the database needs.
-- This is the half people need:
--
--   * the lab being looked at has to be told WHO is in and WHY, by name. Their own database rules
--     stop them reading the supporter's profile row — he's in another lab — so the name and
--     address are copied onto the grant itself at the moment it is issued. Denormalised on
--     purpose: a banner that says "someone has access" is worse than no banner, because it is
--     alarming and un-actionable.
--
--   * Adam has to be able to see which labs exist in order to ask for access to one. He can't
--     read their rows, by design, so a SECURITY DEFINER function returns counts and nothing else
--     — how many people, how many studies. No titles, ever.
--
-- Adam chose break-glass over sealed-forever precisely so he can still fix things. The point was
-- never that he can't get in; it is that he can never get in SILENTLY.

-- 1. Who is in, carried on the grant itself -----------------------------------------
alter table public.support_grants add column if not exists grantee_name  text;
alter table public.support_grants add column if not exists grantee_email text;

comment on column public.support_grants.grantee_name is
  'Copied from the grantee''s profile when the grant is issued. The supported lab cannot read that profile row — it belongs to another lab — so the name has to travel with the grant or the banner cannot name anybody.';

-- 2. Which labs exist, counts only ---------------------------------------------------
-- SECURITY DEFINER so it can see across labs, with the admin check INSIDE the query: a non-admin
-- calling this gets an empty result rather than an error, and there is no branch where it returns
-- anything to someone who shouldn't have it.
--
-- It deliberately returns no titles, no names, no IRB numbers. "spine-singh: 4 people, 11
-- studies" is everything Adam needs to decide whether to ask for access, and nothing he hasn't
-- asked for.
create or replace function public.list_workspaces()
returns table (workspace text, people integer, studies integer)
language sql stable security definer set search_path = public as $$
  select i.workspace,
         count(*) filter (where i.kind = 'profile')::integer,
         count(*) filter (where i.kind = 'study')::integer
    from public.items i
   where public.is_app_admin()
     and i.workspace is not null
   group by i.workspace
   order by i.workspace
$$;

revoke all on function public.list_workspaces() from public;
grant execute on function public.list_workspaces() to authenticated;

-- 3. Ending a grant ------------------------------------------------------------------
-- 001 allowed admins to update a grant. Two things were missing: the grantee should be able to
-- hand access back early without waiting for it to lapse, and a grant that has already ended must
-- stay ended — otherwise "ended" is a field somebody can quietly toggle back, and the audit trail
-- stops being an audit trail.
drop policy if exists "only admins end a grant" on public.support_grants;
create policy "end a grant you hold or administer" on public.support_grants for update to authenticated
using  ((public.is_app_admin() or grantee = auth.uid()) and ended_at is null)
with check (public.is_app_admin() or grantee = auth.uid());

-- VERIFIED after applying -------------------------------------------------------------
--   as Adam:        list_workspaces() returns one row per lab with counts, no titles
--   as a spine user: list_workspaces() returns 0 rows
--   a grant can be ended by its holder and by an admin; an already-ended grant cannot be reopened
