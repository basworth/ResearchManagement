-- Platform admin narrows to Adam.   19 Oct 2026, at his instruction:
-- "carla will and thomas are not admins on other labs"
--
-- 004 split the two roles but deliberately revoked nothing, because removing access is his call.
-- This is that call.
--
-- WHAT THEY KEEP. All three stay `admin: true` on their profile, which since 004 means lab admin
-- of sports-yanke: they see and edit every study in this lab, run the org chart, invite people
-- into this lab. Nothing they do day to day changes.
--
-- WHAT THEY LOSE. Only the cross-lab reach that `is_app_admin()` gates:
--   * granting themselves time-boxed support access into another lab
--   * list_workspaces()
--   * inviting someone into a workspace that isn't their own (i.e. creating a lab)
-- None of the three has ever used any of it — support_grants has zero rows, ever.
--
-- REVERSIBLE, and this file is the record of what was removed. To put any of them back:
--   insert into public.app_admins (user_id) values ('<id below>');
--
--   Carla Edwards    54cf0eb7-2d42-4e3a-bd33-6634311afa64
--   William Lee      157f0d20-bbd7-4e0a-ac58-5ae347762ea8
--   Thomas Turinske  4a168226-a860-4f80-8009-e24e3a2f488e
--
-- Adam (921c9b34-9b9c-49b9-a085-29a146e37341) stays, and the app_admins_keep_one trigger from 004
-- would refuse this anyway if it emptied the table.

delete from public.app_admins where user_id = '54cf0eb7-2d42-4e3a-bd33-6634311afa64';  -- Carla Edwards
delete from public.app_admins where user_id = '157f0d20-bbd7-4e0a-ac58-5ae347762ea8';  -- William Lee
delete from public.app_admins where user_id = '4a168226-a860-4f80-8009-e24e3a2f488e';  -- Thomas Turinske

-- VERIFIED after applying -----------------------------------------------------------------
--   app_admins: 1 row (Adam)
--   all four still lab admins of sports-yanke, profile flag untouched
--   Carla can still edit a colleague's profile in this lab          ✓
--   Carla granting herself support access into another lab          ✓ refused
--   Carla calling list_workspaces()                                 ✓ 0 rows
--
-- LANDMINE, guarded in admin-rights-setup.sql: step 5 of that file backfills every profile's
-- `admin` flag FROM app_admins. Re-running it now would demote all three to ordinary users in
-- one statement. It is pre-004 and must not be run again.
