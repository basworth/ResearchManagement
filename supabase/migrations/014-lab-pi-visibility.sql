-- A PI's research team can see AND edit any study that names their PI.   26 Oct 2026
--
-- Adam, 26 Oct: "anyone that is listed as an investigator on the team means that their study team
-- can also make changes to that study. So whether they are PI or an investigator, the team that
-- manages their research would be able to edit those studies as well as see them." And: the rules
-- are lab-based and the same for every lab — what Will and TJ are in his lab, Matthew Kao and Lee
-- Friedman are in Cole's, and Singh's people will be in his.
--
-- THE RULES, ONE LAB AT A TIME (unchanged here, restated so this file reads on its own):
--   * Lab admin (the PI and their research team — Adam, Will, TJ in sports-yanke): every study in
--     the lab, read and write, and may staff the lab (010).
--   * Everyone else in the lab: the studies they're involved in (011), read and write.
--   * Section coverage (Carla, Sports): every lab in the section (009).
--   * App admin (Adam): break-glass support access only, never standing (002).
--
-- THE NEW RULE, ACROSS LABS: if a study anywhere names a lab's PI — on Team, or anywhere in the PI
-- field, including combined ones like "Adam Yanke, Brian Cole, Jorge Chahla" — then whoever
-- MANAGES that PI's lab (its lab admins, or someone covering its section) may read and edit it.
-- Only managers: an RA in Cole's lab gets no more across labs than an RA gets inside one.
-- App admin does NOT count as managing every lab here — Adam's rule is that he sees other labs'
-- studies only when they name him.
--
-- EDIT, NOT TAKE. The study stays in its own lab: a manager may change an existing study but may
-- not create one in another lab, relabel it into their own, or delete it. The app writes with an
-- upsert, which Postgres checks against the INSERT policy too, so the insert path is opened only
-- for a row that already exists in that same lab (study_stays_put).
--
-- Which person is a lab's PI is stated, not inferred, in lab_pis: "whoever is lab admin" would
-- name Carla, Will and TJ for sports-yanke.
--
-- Full names only, as in 012: a surname would let two different Coles reach each other's work.
--
-- ROLLBACK: restore "workspace read" from 013 and "workspace insert"/"workspace update" to
--   insert with check ((workspace in (select my_workspaces())) or kind = 'meeting')
--   update using/with check ((workspace in (select my_workspaces())) or kind = 'meeting'
--                            or has_support_access(workspace))
-- and `drop trigger guard_relabel on public.items`. lab_pis and the functions can stay; nothing
-- reads them then. No study row changes.

create table if not exists public.lab_pis (
  workspace text primary key,
  pi_name   text not null check (length(trim(pi_name)) > 0),
  added_at  timestamptz not null default now()
);
alter table public.lab_pis enable row level security;
-- No policies on purpose: read only through the security-definer functions below.

insert into public.lab_pis (workspace, pi_name) values
  ('sports-yanke',  'Adam Yanke'),
  ('sports-cole',   'Brian Cole'),
  ('sports-chahla', 'Jorge Chahla'),
  ('spine-singh',   'Kern Singh')
on conflict (workspace) do nothing;

-- Every name a study carries in Team or PI, lowercased. The PI field is free text and often holds
-- several people, so it is split on , ; / & and the word "and".
create or replace function public.study_named_people(d jsonb)
returns setof text
language sql immutable
set search_path to 'public'
as $$
  select lower(trim(v)) from jsonb_array_elements_text(
      case when jsonb_typeof(d->'team') = 'array' then d->'team' else '[]'::jsonb end) v
   where trim(v) <> ''
  union
  select lower(trim(p)) from regexp_split_to_table(coalesce(d->>'pi', ''), '\s*(?:,|;|/|&|\mand\M)\s*', 'i') p
   where trim(p) <> ''
$$;

-- The labs I manage: lab admin of my own lab, or covering its section. NOT app admin.
create or replace function public.manages_lab(ws text)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select (public.is_lab_admin() and ws = public.my_workspace())
      or exists (select 1 from public.my_division_workspaces() w where w = ws)
$$;

-- The PIs of the labs I manage.
create or replace function public.my_lab_pi_names()
returns setof text
language sql stable security definer
set search_path to 'public'
as $$
  select lower(trim(pi_name)) from public.lab_pis where public.manages_lab(workspace)
$$;

create or replace function public.lab_pi_named(d jsonb)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.study_named_people(d) n
     where n in (select public.my_lab_pi_names())
  )
$$;

-- The row already exists, as a study, in this same lab. Security definer so it sees the row
-- regardless of the caller's read access, and so the policy doesn't recurse into itself.
create or replace function public.study_stays_put(row_id uuid, ws text)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select exists (select 1 from public.items i where i.id = row_id and i.kind = 'study' and i.workspace = ws)
$$;

revoke all on function public.study_named_people(jsonb) from public;
revoke all on function public.manages_lab(text) from public;
revoke all on function public.my_lab_pi_names() from public;
revoke all on function public.lab_pi_named(jsonb) from public;
revoke all on function public.study_stays_put(uuid, text) from public;
grant execute on function public.study_named_people(jsonb) to authenticated;
grant execute on function public.manages_lab(text) to authenticated;
grant execute on function public.my_lab_pi_names() to authenticated;
grant execute on function public.lab_pi_named(jsonb) to authenticated;
grant execute on function public.study_stays_put(uuid, text) to authenticated;

drop policy if exists "workspace read" on public.items;
create policy "workspace read" on public.items for select to authenticated
using (
  kind = 'meeting'
  or public.has_support_access(workspace)
  or (
    workspace in (select public.my_workspaces())
    and (
      kind <> 'study'
      or public.sees_whole_lab(workspace)
      or public.is_involved(data)
      or public.assigned_on_study(id::text)
    )
  )
  -- Named on it, wherever it lives (migration 012).
  or (
    kind = 'study'
    and (public.is_collaborator(data) or public.assigned_on_study_strict(id::text))
  )
  -- NEW: it names the PI of a lab I manage (this migration).
  or (
    kind = 'study'
    and public.lab_pi_named(data)
  )
  -- Whoever shares a lab with me, whatever their own primary lab says (migration 013).
  or (
    kind = 'profile'
    and exists (
      select 1 from public.lab_members lm
       where lm.user_id = items.id
         and lm.workspace in (select public.my_workspaces())
    )
  )
);

drop policy if exists "workspace update" on public.items;
create policy "workspace update" on public.items for update to authenticated
using (
  workspace in (select public.my_workspaces())
  or kind = 'meeting'
  or public.has_support_access(workspace)
  -- NEW: an existing study naming the PI of a lab I manage.
  or (kind = 'study' and public.lab_pi_named(data))
)
with check (
  workspace in (select public.my_workspaces())
  or kind = 'meeting'
  or public.has_support_access(workspace)
  -- NEW: ...and it still names them, and stays in the lab it was in.
  or (kind = 'study' and public.lab_pi_named(data) and public.study_stays_put(id, workspace))
);

drop policy if exists "workspace insert" on public.items;
create policy "workspace insert" on public.items for insert to authenticated
with check (
  workspace in (select public.my_workspaces())
  or kind = 'meeting'
  -- NEW: only the upsert of a study that already exists in that same lab — never a new study in
  -- somebody else's lab.
  or (kind = 'study' and public.lab_pi_named(data) and public.study_stays_put(id, workspace))
);

-- Delete is deliberately untouched: removing a study stays with its own lab.

-- Nor may it be MOVED by anyone outside its lab. A row policy sees only one version of the row,
-- so on its own the update policy would let Cole's manager change QMRI OCA's lab from sports-yanke
-- to sports-cole — the new label is a lab they're in, so the WITH CHECK passes — and walk off with
-- it. Only its own lab (or support access) may change a row's lab. Service-role and SQL-editor
-- writes have no auth.uid() and are not affected; that is how labs are staffed and studies moved
-- on Adam's say-so. errcode 42501 makes the app say "you don't have permission to change that."
create or replace function public.guard_relabel()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $$
begin
  if new.workspace is distinct from old.workspace
     and auth.uid() is not null
     and not (old.workspace in (select public.my_workspaces()) or public.has_support_access(old.workspace))
  then
    raise exception 'only its own lab can move this' using errcode = '42501';
  end if;
  return new;
end
$$;
drop trigger if exists guard_relabel on public.items;
create trigger guard_relabel before update on public.items
  for each row execute function public.guard_relabel();

-- VERIFY — inside `begin; ... rollback;`, as real users:
--   a. Matthew Kao, once lab admin of sports-cole: reads and edits QMRI OCA (Cole only in a
--      combined PI field); cannot insert a new study labelled sports-yanke; cannot relabel QMRI
--      OCA to sports-cole; cannot read or edit a sports-yanke study that doesn't name Cole.
--   b. An RA in sports-cole who is not lab admin: no new access.
--   c. Will (lab admin of sports-yanke): reads and edits CARTISTEM (names Adam on Team).
--   d. Adam's own study count changes only by studies elsewhere naming him, which he already saw.
