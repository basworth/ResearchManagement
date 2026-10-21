-- "Yanke" becomes "Adam Yanke" on every study.   19 Oct 2026, at his instruction:
-- "anywhere it says yanke it should be moved to me being tagged as a formal name"
--
-- Why it matters beyond tidiness: when labs become per-PI, the `pi` field is what answers "whose
-- lab owns this study". A surname written two ways is two different owners to anything matching
-- on it, and 56 of his studies would have ended up unassigned or in the wrong place.
--
-- SCOPE. The `pi` field only. Deliberately NOT touched:
--   * publication.authorList — "Adam B Yanke" there is the PubMed citation, not a tag. 276 rows,
--     all left exactly as they are.
--   * team arrays and task assignees — already "Adam Yanke" everywhere (122 and 14 rows checked).
--   * the roster — already carries "Adam Yanke" and no bare "Yanke".
--
-- THE GUARD THAT MATTERS. "Adam Yanke" contains " Yanke", so an unguarded replace turns it into
-- "Adam Adam Yanke" on the 282 rows that were already correct. The `not ilike '%Adam Yanke%'`
-- clause is what stops that, and it was dry-run before being applied.
--
-- REVERSIBLE WITHOUT THIS FILE. Each changed row carries its own previous value in `data.piWas`,
-- so nothing is lost and the undo needs no external list:
--   update public.items set data = data || jsonb_build_object('pi', data->>'piWas')
--    where kind='study' and data ? 'piWas';
-- `piWas` is additive and ignored by the app. Leave it; it is the record.

update public.items
   set data = data
            || jsonb_build_object('pi', regexp_replace(data->>'pi',
                   '(^|[^A-Za-z])Yanke([^A-Za-z]|$)', '\1Adam Yanke\2', 'g'))
            || jsonb_build_object('piWas', data->>'pi'),
       updated_at = now()
 where kind = 'study'
   and data->>'pi' ~ '(^|[^A-Za-z])Yanke([^A-Za-z]|$)'
   and data->>'pi' not ilike '%Adam Yanke%';

-- APPLIED, 66 rows. Verified after -----------------------------------------------------
--   "Adam Yanke"                 282 → 338
--   bare "Yanke" remaining         0
--   "Adam Adam ..." anywhere       0
--   rows carrying piWas           66
--   publication citations intact 276
--
-- STILL INCONSISTENT, left alone because they are not his name to formalise:
--   pi = "Chahla"  (2 studies)          → presumably Jorge Chahla
--   pi = "Adam Yanke, Cole"  (3)        → presumably Brian Cole
--   pi = "Adam Yanke, Chahla" (1), "Chahla, Adam Yanke" (1), "Adam Yanke, Cole, Chahla" (1)
--   pi = "Adam Yanke, Hannah" (4)       → no surname for Hannah exists anywhere in the data
--   45 studies with no PI at all
-- The roster also holds bare "Cole" and "Chahla" ALONGSIDE "Brian Cole" and "Jorge Chahla",
-- which the in-app name-merge tool is built to collapse.
