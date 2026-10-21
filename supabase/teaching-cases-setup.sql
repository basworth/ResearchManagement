-- ============================================================================
-- Teaching Cases — tables and access rules.
--
-- Lives in the same Supabase project as the Research Tracker so people keep one login, but in
-- its OWN tables with its OWN access list. Being able to sign in to the tracker does NOT let you
-- see teaching cases; only people the owner approves can.
--
-- No PHI is stored here by design: no names, MRNs or real dates. Dates are kept as days from the
-- index surgery (plus the surgery year); the real dates live in the key sheet on the Rush drive.
--
-- Nothing is ever hard-deleted: there is no DELETE policy on either table, so the API refuses
-- deletes outright. Cases are archived; access is revoked by setting role = 'revoked'.
--
-- Safe to re-run.
-- ============================================================================

-- 1. Who may see teaching cases ------------------------------------------------
create table if not exists case_access (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  name       text,
  role       text not null check (role in ('requested', 'viewer', 'editor', 'owner', 'revoked')),
  granted_by uuid,
  updated_at timestamptz not null default now()
);
alter table case_access enable row level security;

-- SECURITY DEFINER so policies can consult case_access without recursing into its own RLS.
create or replace function case_role(uid uuid default auth.uid())
returns text language sql security definer stable
set search_path = public
as $$ select role from case_access where user_id = uid; $$;

create or replace function case_can_view(uid uuid default auth.uid())
returns boolean language sql security definer stable
set search_path = public
as $$ select coalesce(case_role(uid) in ('viewer', 'editor', 'owner'), false); $$;

create or replace function case_can_edit(uid uuid default auth.uid())
returns boolean language sql security definer stable
set search_path = public
as $$ select coalesce(case_role(uid) in ('editor', 'owner'), false); $$;

create or replace function case_is_owner(uid uuid default auth.uid())
returns boolean language sql security definer stable
set search_path = public
as $$ select coalesce(case_role(uid) = 'owner', false); $$;

drop policy if exists case_access_read on case_access;
create policy case_access_read on case_access
  for select to authenticated
  using (user_id = auth.uid() or case_is_owner());

-- Anyone signed in may ask for access — but only for themselves, and only as a request.
drop policy if exists case_access_request on case_access;
create policy case_access_request on case_access
  for insert to authenticated
  with check ((user_id = auth.uid() and role = 'requested') or case_is_owner());

drop policy if exists case_access_owner_update on case_access;
create policy case_access_owner_update on case_access
  for update to authenticated
  using (case_is_owner()) with check (case_is_owner());

-- Re-requesting after a refusal: let a person flip their OWN revoked row back to 'requested'.
drop policy if exists case_access_rerequest on case_access;
create policy case_access_rerequest on case_access
  for update to authenticated
  using (user_id = auth.uid() and role = 'revoked')
  with check (user_id = auth.uid() and role = 'requested');

-- Never leave the cases without an owner.
create or replace function guard_case_access() returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner' then
    if (select count(*) from case_access where role = 'owner' and user_id <> old.user_id) = 0 then
      raise exception 'Cannot remove the last owner — make someone else an owner first';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists case_access_guard on case_access;
create trigger case_access_guard before insert or update on case_access
  for each row execute function guard_case_access();

-- Seed Adam as the owner.
insert into case_access (user_id, email, role)
select id, email, 'owner' from auth.users where email = 'adam.yanke@rushortho.com'
on conflict (user_id) do update set role = 'owner';

-- 2. The cases ------------------------------------------------------------------
create table if not exists teaching_cases (
  id         uuid primary key default gen_random_uuid(),
  case_no    bigint generated always as identity,
  data       jsonb not null default '{}'::jsonb,
  archived   boolean not null default false,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create unique index if not exists teaching_cases_case_no on teaching_cases (case_no);
alter table teaching_cases enable row level security;

drop policy if exists teaching_cases_read on teaching_cases;
create policy teaching_cases_read on teaching_cases
  for select to authenticated using (case_can_view());

drop policy if exists teaching_cases_insert on teaching_cases;
create policy teaching_cases_insert on teaching_cases
  for insert to authenticated with check (case_can_edit());

drop policy if exists teaching_cases_update on teaching_cases;
create policy teaching_cases_update on teaching_cases
  for update to authenticated using (case_can_edit()) with check (case_can_edit());
-- (No delete policy: deletes are refused. Archive instead.)

-- Stamps only — deliberately does not trust OLD, so it behaves the same for insert and update.
create or replace function stamp_teaching_case() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
drop trigger if exists teaching_cases_stamp on teaching_cases;
create trigger teaching_cases_stamp before insert or update on teaching_cases
  for each row execute function stamp_teaching_case();

-- 3. Field-level saves ------------------------------------------------------------
-- Two people editing different parts of one case must not erase each other's work (the lesson
-- from the tracker's whole-record overwrite). patch_case merges only the fields sent, and merges
-- timeline events one by one, so adding an event never drops someone else's.
-- SECURITY INVOKER: the RLS update policy above still applies.
create or replace function patch_case(case_id uuid, patch jsonb, set_archived boolean default null)
returns teaching_cases language plpgsql
set search_path = public
as $$
declare
  result teaching_cases;
begin
  update teaching_cases t
     set data = case
                  when patch ? 'events' then
                    (t.data || (patch - 'events'))
                    || jsonb_build_object('events',
                         coalesce(t.data->'events', '{}'::jsonb) || coalesce(patch->'events', '{}'::jsonb))
                  else t.data || patch
                end,
         archived = coalesce(set_archived, t.archived)
   where t.id = case_id
  returning * into result;
  if result.id is null then
    raise exception 'Case not found, or you do not have edit access';
  end if;
  return result;
end;
$$;
grant execute on function patch_case(uuid, jsonb, boolean) to authenticated;

-- 4. Live updates -----------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table teaching_cases;
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Checks:
--   select email, role from case_access;
--   select case_no, data->>'title', archived from teaching_cases order by case_no;
-- ---------------------------------------------------------------------------
