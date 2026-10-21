-- ============================================================================
-- Admin rights, enforced by the database rather than by the app.
--
-- Until now "admin" was a boolean inside a profile's jsonb, and the only thing stopping a
-- non-admin from setting their own was the app's own JavaScript. Since the items policy lets
-- any signed-in account write any row, anyone could have granted themselves admin by talking
-- to the API directly. This makes app_admins the authority and enforces it in a trigger.
-- ============================================================================

-- 1. The authority. Deliberately its own table, not a column in a jsonb blob users can write.
create table if not exists app_admins (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table app_admins enable row level security;

-- SECURITY DEFINER so it bypasses RLS on app_admins. Without this, a policy on app_admins that
-- queries app_admins recurses infinitely and Postgres refuses the query outright.
create or replace function is_app_admin(uid uuid default auth.uid())
returns boolean language sql security definer stable
set search_path = public
as $$ select exists (select 1 from app_admins where user_id = uid); $$;

drop policy if exists app_admins_read on app_admins;
create policy app_admins_read on app_admins
  for select to authenticated using (true);          -- the app shows admin badges to everyone

drop policy if exists app_admins_write on app_admins;
create policy app_admins_write on app_admins
  for all to authenticated
  using (is_app_admin()) with check (is_app_admin());

-- 2. Seed the current admins. Matched by email so it survives id changes.
insert into app_admins (user_id)
select id from auth.users
 where email in ('adam.yanke@rushortho.com', 'william.lee@rushortho.com', 'thomas.turinske@rushortho.com')
on conflict (user_id) do nothing;

-- 3. The guard. Fires on every write to `items` but only cares about profile rows.
create or replace function guard_profile_writes() returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  caller       uuid := auth.uid();
  caller_admin boolean;
  wants_admin  boolean := coalesce((new.data->>'admin')::boolean, false);
  had_admin    boolean := case when tg_op = 'UPDATE'
                               then coalesce((old.data->>'admin')::boolean, false)
                               else false end;
  admin_count  integer;
begin
  if new.kind is distinct from 'profile' then return new; end if;

  -- caller is null for the service role (edge functions) and the SQL editor. Those bypass RLS
  -- anyway, and the `items` policy already blocks the anon role, so nothing unauthenticated
  -- reaches this point.
  caller_admin := caller is null or is_app_admin(caller);

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

  -- 4. Allowed writer: keep app_admins in step with the flag they just set, so there is one
  --    place to click and one source of truth.
  if wants_admin then
    insert into app_admins (user_id) values (new.id) on conflict (user_id) do nothing;
  elsif had_admin then
    delete from app_admins where user_id = new.id;
    select count(*) into admin_count from app_admins;
    if admin_count = 0 then
      -- Removing the last admin would leave nobody able to appoint one. Refuse.
      raise exception 'Cannot remove the last admin — promote someone else first';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists items_guard_profile on items;
create trigger items_guard_profile
  before insert or update on items
  for each row execute function guard_profile_writes();

-- 5. Make the stored flags agree with app_admins, so the app's badges match reality.
--
-- ============================== DO NOT RUN THIS AGAIN ==============================
-- Correct when written, and now actively dangerous. It assumes the profile `admin` flag and
-- app_admins mean the same thing — which was true until migration 004 split them into lab admin
-- and platform admin, and false since.
--
-- As of 005, app_admins holds Adam alone, while Carla Edwards, William Lee and Thomas Turinske
-- are lab admins of sports-yanke. Re-running the statement below would set their flag to false
-- and demote all three to ordinary users in one go, silently, with the only symptom being that
-- they can no longer edit anything they aren't named on.
--
-- The whole file is pre-004 and is kept as a record of how app_admins was set up, not as
-- something to execute. The live definitions are in migrations/004-lab-admin.sql.
-- ===================================================================================
--
-- update items i
--    set data = i.data || jsonb_build_object('admin', is_app_admin(i.id)),
--        updated_at = now()
--  where i.kind = 'profile'
--    and coalesce((i.data->>'admin')::boolean, false) is distinct from is_app_admin(i.id);

-- ---------------------------------------------------------------------------
-- Checks:
--   select u.email from app_admins a join auth.users u on u.id = a.user_id;
--   select data->>'name', data->>'admin' from items where kind = 'profile';
-- ---------------------------------------------------------------------------
