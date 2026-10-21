-- Lab admin and app admin stop being the same thing.   16 Oct 2026
--
-- Found while answering "is it ready to send to Kern?". It wasn't, and this was why: the profile
-- flag `admin` is synced into `app_admins` by a trigger, and `is_app_admin()` is what gates
--   * granting yourself time-boxed support access into ANY workspace
--   * list_workspaces()
--   * inviting into a workspace that isn't your own
--
-- So the only way to let a second PI invite his own team was to hand him the keys to the first
-- lab. That isn't a setting anyone would have noticed; it's the shape of the model.
--
-- The split:
--   lab admin  = `admin: true` on your profile row. Sees and edits everything in YOUR lab, runs
--                your org chart, invites your team. Per-lab, because profile rows are per-lab.
--   app admin  = a row in app_admins. Support access, cross-lab invites, list_workspaces.
--                Nothing grants it automatically any more — it is added by hand, by Adam.
--
-- NOTHING IS REVOKED HERE. The four accounts already in app_admins keep what they have; this
-- only stops NEW lab admins from being added to it. Narrowing the existing four is Adam's call
-- and his alone — see the note at the bottom.

-- 1. "Is this person an admin of their own lab?" --------------------------------------
-- SECURITY DEFINER for the same reason my_workspace() is: a policy that had to read a profile
-- row in order to decide whether it may read profile rows would never return anything.
create or replace function public.is_lab_admin(uid uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select (i.data->>'admin')::boolean from public.items i
      where i.kind = 'profile' and i.id = uid limit 1),
    false)
$$;
revoke all on function public.is_lab_admin(uuid) from public;
grant execute on function public.is_lab_admin(uuid) to authenticated;

-- 2. The profile guard, rewritten ------------------------------------------------------
-- Same shape as before, with two changes, both marked below. Everything else is kept verbatim —
-- including the no-op escape hatch, which exists because pushAllLocal re-sends every profile row
-- and an identical write must not be treated as an attempted edit.
create or replace function guard_profile_writes() returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  caller       uuid := auth.uid();
  caller_admin boolean;
  same_lab     boolean;
  wants_admin  boolean := coalesce((new.data->>'admin')::boolean, false);
  had_admin    boolean := case when tg_op = 'UPDATE'
                               then coalesce((old.data->>'admin')::boolean, false)
                               else false end;
begin
  if new.kind is distinct from 'profile' then return new; end if;

  -- caller is null for the service role (edge functions) and the SQL editor. Those bypass RLS
  -- anyway, and the `items` policy already blocks the anon role, so nothing unauthenticated
  -- reaches this point.
  --
  -- CHANGE 1: a lab admin counts as an admin for profiles IN THEIR OWN LAB. Without this, a PI
  -- could not promote their own coordinator, which is the whole point of the split.
  same_lab := new.workspace is not distinct from (select workspace from public.items
                where kind = 'profile' and id = caller limit 1);
  caller_admin := caller is null
               or is_app_admin(caller)
               or (is_lab_admin(caller) and same_lab);

  if not caller_admin then
    -- The app re-pushes rows it already holds (pushAllLocal sends every profile). An identical
    -- write is a no-op, so let it through rather than breaking sync for non-admins.
    if tg_op = 'UPDATE' and new.data = old.data then return new; end if;

    if new.id is distinct from caller then
      raise exception 'Only an admin can change someone else''s profile';
    end if;
    if wants_admin is distinct from had_admin then
      raise exception 'Only an admin can grant or remove admin rights';
    end if;
    return new;
  end if;

  -- CHANGE 2: the flag no longer writes to app_admins. It used to, so that there was "one place
  -- to click and one source of truth" — true and useful with one lab, and the exact mechanism
  -- that would have handed a second PI support access to the first lab. app_admins is now set by
  -- hand and means only what its name says.
  --
  -- The "cannot remove the last admin" guard moves to app_admins itself, below, because that is
  -- now the table it was always really protecting.
  return new;
end;
$$;

drop trigger if exists items_guard_profile on items;
create trigger items_guard_profile
  before insert or update on items
  for each row execute function guard_profile_writes();

-- 3. Keep the last app admin from deleting themselves ----------------------------------
-- Previously enforced inside the profile trigger. It belongs here: app_admins is the table whose
-- emptiness would leave nobody able to appoint anyone.
create or replace function public.guard_last_app_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.app_admins) = 0 then
    raise exception 'Cannot remove the last admin — promote someone else first';
  end if;
  return null;
end;
$$;
drop trigger if exists app_admins_keep_one on public.app_admins;
create constraint trigger app_admins_keep_one
  after delete on public.app_admins
  deferrable initially deferred
  for each row execute function public.guard_last_app_admin();

-- VERIFIED after applying, each inside a rolled-back transaction -------------------------
--   a lab admin can set admin on a teammate in their own lab        ✓
--   ...and cannot on a profile in another lab                       ✓ refused
--   granting lab admin no longer adds a row to app_admins           ✓
--   is_app_admin() for the four existing admins is unchanged        ✓
--   deleting every app_admins row is refused                        ✓
--
-- STILL ADAM'S CALL, deliberately not done here: Carla Edwards, William Lee and Thomas Turinske
-- are in app_admins today, so all three can grant themselves support access into any lab that
-- ever exists. That was harmless with one lab. Removing them is removing access, which is his to
-- decide, not a migration's.
