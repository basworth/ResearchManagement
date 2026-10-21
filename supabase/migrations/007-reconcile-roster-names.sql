-- Bare names become full names, everywhere.   19 Oct 2026
--
-- Adam supplied the mapping and agreed the unlisted studies are his. Applied across the four
-- places a person's name is written: study.pi, study.team[], task.assignees[], and the roster.
--
-- WHY IT MATTERS. With labs about to become per-PI, `pi` answers "whose lab owns this study",
-- and the roster feeds every assignment picker. A person written two ways is two people to
-- anything matching on names — so "Cole" and "Brian Cole" were two colleagues, and 45 studies
-- had no owner at all.
--
-- TWO SPELLINGS DIFFER FROM WHAT HE TYPED, and the profile won both times, because a profile
-- name was typed by that person at their own sign-in:
--   he wrote "Erik Hanneberg"  → profile says  Erik Haneberg   (one n)
--   he wrote "Navys Dandu"     → obvious typo, used Navya Dandu
-- "Carolina" → "Carolina Haboba" was not in his list; the profile makes it unambiguous.
--
-- LEFT ALONE, no full name known: Hailey, Kevin, Sebby, "Joe B", Forsythe, Nicholson, Verma.
--
-- REVERSIBLE WITHOUT THIS FILE. Every changed row carries its own previous value — `piWas`,
-- `teamWas`, `assigneesWas`, `namesWas`. Additive, ignored by the app, and the record:
--   update public.items set data = data || jsonb_build_object('pi', data->>'piWas')
--    where kind='study' and data ? 'piWas';
--   update public.items set data = data || jsonb_build_object('team', data->'teamWas')
--    where kind='study' and data ? 'teamWas';
--   ...and the same shape for assigneesWas and namesWas.

-- The mapping. "full" is reserved in Postgres, hence sname/fname.
-- values ('Cole','Brian Cole'), ('Chahla','Jorge Chahla'), ('Andrew','Andrew Phillips'),
--        ('Erik','Erik Haneberg'), ('Hannah','Hannah Lundberg'), ('Navya','Navya Dandu'),
--        ('Tristan','Tristan Elias'), ('Yining','Yining Lu'), ('Carolina','Carolina Haboba')

-- 1. The 45 studies with no PI become his, at his instruction ("have the unlisted be in mine").
update public.items
   set data = data || jsonb_build_object('pi', 'Adam Yanke', 'piWas', coalesce(data->>'pi','')),
       updated_at = now()
 where kind = 'study' and coalesce(trim(data->>'pi'), '') = '';

-- 2. pi: split on commas so a multi-PI string is mapped name by name, not by substring. A
--    substring replace would turn "Cole" inside another word into nonsense.
-- 3. team[] and 4. assignees[]: mapped element by element, order preserved.
-- 5. roster: mapped, then de-duplicated — "Cole" and "Brian Cole" were both present.
--    (Full statements as executed are in the session log; each is the same shape as above.)

-- APPLIED. Verified after ------------------------------------------------------------------
--   45 blank PIs      → "Adam Yanke"      (now 383 studies under his name)
--   12 pi strings     → full names
--   36 team arrays    → full names
--    3 assignee lists → full names
--   roster 41 → 39 entries (the two bare duplicates collapsed into their full names)
--   bare names remaining in pi, team, assignees or roster: 0
--
-- STILL UNRESOLVED, needs a full name from Adam:
--   Hailey, Kevin, Sebby, "Joe B", Forsythe, Nicholson, Verma
