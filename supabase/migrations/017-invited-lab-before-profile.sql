-- A newly invited person belongs to the lab they were invited to, before they have a profile.   28 Oct 2026
--
-- Found 28 Oct: Max Lee, Rohit Kalra (Singh lab) and Ruby Rader (Chahla lab) had all signed in, but
-- none had a profile row. my_workspace()/my_workspaces() fell back to 'sports-yanke' for anyone
-- without a profile, so:
--   * their first profile save, stamped with their real lab (spine-singh, sports-chahla), failed the
--     insert policy (workspace in my_workspaces()) — they could never finish setting up; and
--   * until then the database treated them as members of Adam's lab, so the non-study rows there
--     (tasks, notes, team list) were readable to them.
-- Cole's RAs never hit it because they were invited before labs existed, into sports-yanke.
--
-- FIX: before a profile exists, the lab is the one the invite placed them in. invite-user records
-- it on the account. user_metadata can be edited by the user themselves, so it is copied into
-- app_metadata (writable only by the service role) and only app_metadata is trusted here.
-- Legacy accounts with neither keep the old 'sports-yanke' fallback; public sign-up is off (27 Oct),
-- so no new account can arrive without an invite.
--
-- ROLLBACK: restore my_workspace()/my_workspaces() with the plain 'sports-yanke' fallback.

create or replace function public.invited_workspace()
returns text
language sql stable security definer
set search_path to 'public', 'auth'
as $$
  select nullif(trim(u.raw_app_meta_data->>'workspace'), '') from auth.users u where u.id = auth.uid()
$$;
revoke all on function public.invited_workspace() from public;
grant execute on function public.invited_workspace() to authenticated;

create or replace function public.my_workspace()
returns text
language sql stable security definer
set search_path to 'public'
as $$
  select coalesce(
    (select i.workspace from public.items i where i.kind = 'profile' and i.id = auth.uid() limit 1),
    public.invited_workspace(),
    'sports-yanke')
$$;

create or replace function public.my_workspaces()
returns setof text
language sql stable security definer
set search_path to 'public'
as $$
  select workspace from public.lab_members where user_id = auth.uid()
  union
  select coalesce(
    (select i.workspace from public.items i
      where i.kind = 'profile' and i.id = auth.uid() limit 1),
    public.invited_workspace(),
    'sports-yanke')
  union
  select * from public.my_division_workspaces()
$$;

-- Every invited account so far carries its lab in user_metadata only. Copy it across for accounts
-- that have no profile yet (those with a profile are decided by the profile and are unaffected).
update auth.users u
   set raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object('workspace', u.raw_user_meta_data->>'workspace')
 where coalesce(u.raw_user_meta_data->>'workspace', '') <> ''
   and not exists (select 1 from public.items i where i.kind = 'profile' and i.id = u.id);

-- VERIFY — as Max Lee (spine-singh, no profile): my_workspaces() = {spine-singh}; can insert his own
-- profile in spine-singh; sees 0 sports-yanke tasks/notes/profiles. As Adam: unchanged.
