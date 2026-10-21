-- A PI's direct research team.   19 Oct 2026
--
-- Will and TJ work for Adam. They need to see every one of his studies — not only the ones they
-- are named on — and to start new ones that are his from the moment they're created. Today the
-- only ways to arrange that are to make somebody an admin, which is far too much, or to add them
-- to every study by hand, which is far too little and gets forgotten.
--
-- So a PI designates their own research team. Membership of that team IS membership of that PI's
-- lab: labs are one-per-PI, so "everything of Adam's" and "everything in sports-yanke" are the
-- same set of rows. That means no new visibility mechanism and no second code path — a team row
-- simply writes a lab_members row, which migration 008 already made load-bearing, and everything
-- downstream keeps working unchanged.
--
-- What is new is WHO may write it. Until now lab_members was app-admin-only. A PI must be able to
-- staff their own lab without coming to Adam, so this adds a second, deliberately narrow path:
-- a lab admin may add and remove members OF THEIR OWN LAB, and nothing else. They still cannot
-- put themselves in anybody else's lab, which is the attack this table has always guarded against.
--
-- Somebody can be on several PIs' teams — Will may work for Adam and for Chahla. That is why
-- 'which PI is this study under' has to be asked when such a person creates one, and why the
-- study is stamped with THAT PI's workspace rather than the creator's. The app handles the
-- asking; this migration only makes the membership possible.
--
-- ROLLBACK: drop the two policies added here and restore `lab_members_write` to the single
-- is_app_admin() definition in migration 008. No row is modified by this migration; the team
-- rows it enables are ordinary lab_members rows with source = 'team' and can be deleted.

-- 1. Who may staff a lab ------------------------------------------------------------------------
-- Replaces the blanket admin-only write with two explicit paths, so that reading the policy tells
-- you the rule rather than requiring you to know it.
drop policy if exists lab_members_write on public.lab_members;

-- An app admin may do anything, as before.
create policy lab_members_admin_write on public.lab_members for all to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());

-- A lab admin may staff their own lab. Both USING and WITH CHECK are constrained to that same
-- workspace: USING alone would let them delete other labs' rows, and WITH CHECK alone would let
-- them move a row out of their lab into another. The two together mean the row has to belong to
-- their lab both before and after.
create policy lab_members_lab_admin_write on public.lab_members for all to authenticated
  using      (public.is_lab_admin() and workspace = public.my_workspace())
  with check (public.is_lab_admin() and workspace = public.my_workspace());

-- 2. Why each person is in a lab ------------------------------------------------------------------
-- `source` already exists from 008 ('profile' = seeded from their original single workspace,
-- 'granted' = added deliberately by an app admin). 'team' is the third: put there by the PI as
-- part of their research team. Worth distinguishing, because it answers "who added this person
-- and on what authority" without an audit log.
--
-- Nothing enforces the vocabulary — a constraint would turn a future value into an outage — but
-- the app writes only these three.
comment on column public.lab_members.source is
  'profile = seeded from the original single workspace (008); granted = added by an app admin; team = added by the PI as their research team (010)';

-- VERIFY — each inside `begin; ... rollback;`, as real users, never as service role.
--
--   a. Adam (lab admin of sports-yanke) can insert a lab_members row for sports-yanke.
--   b. Adam CANNOT insert one for spine-singh. This is the whole point of the with-check.
--   c. Adam cannot UPDATE an existing sports-yanke row to say spine-singh.
--   d. Adam cannot delete a spine-singh row.
--   e. Will, added to sports-yanke by Adam, reads every study in sports-yanke including ones he
--      is not named on, and reads nothing in spine-singh.
--   f. Will is still not is_lab_admin() and not is_app_admin() — being on a team is not being an
--      admin, so he cannot in turn add anybody.
--   g. A non-admin member of sports-yanke cannot insert into lab_members at all.
