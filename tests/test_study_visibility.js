// Studies become visible by involvement — 19 Oct 2026.
//
// Being in a lab used to mean reading every row in it: all thirteen non-admins in sports-yanke
// could open all 397 studies. Now an RA sees what they're on; lab admins (Will, TJ) see all of
// their PI's; and section coverage (Carla) still sees everything in Sports.
//
// This is the most dangerous change in the project so far, because its failure mode is silent.
// A name that doesn't match means somebody quietly cannot open their own study, and the first
// you hear of it is a person saying "it's gone". So the tests lean hard on:
//
//   1. The two definitions agreeing. The SQL decides; the JS only draws the number on screen. If
//      they drift, the sheet tells Adam something false about who can see what.
//
//   2. Every field that can carry a name being read — especially BOTH author lists. The first
//      dry run read only one and understated everyone's access by roughly two thirds. That near
//      miss is why these assertions are per-field.
//
//   3. The shapes that raise rather than return nothing. `team` has been a string in old rows and
//      an array in new ones; jsonb_array_elements on the wrong type throws, and a policy that
//      throws makes the row vanish for everybody with no error anyone would ever see.
//
//   4. Only studies narrowing. A task on a study you can't read still has to reach your task list.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const ME = "u-adam";
const now = new Date().toISOString();
const profile = (id, name, admin) => ({
  id, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: { id, email: id + "@example.com", name, position: "Clinician", reportsTo: "",
    alertEmail: "", alertEmailAsked: true, degreesAsked: true, tourSeen: 1,
    fieldsChosen: true, linkedTo: "", admin: !!admin },
});

function boot() {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({
        items: [profile(ME, "Adam Yanke", true), profile("u-ra", "Carolina Haboba", false)] }) };
    },
  });
  return dom.window;
}

const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}

(async () => {
  const w = boot();
  await wait(600);
  const ev = (c) => w.eval(c);
  const RA = { id: "u-ra", name: "Carolina Haboba", admin: false };

  console.log("\n-- Every field that can carry a name is read --");
  // One study per field, so a dropped field fails exactly one assertion and names itself.
  const CASES = [
    ["Team (array)",            { id: "s1", team: ["Adam Yanke", "Carolina Haboba"] }],
    ["Team (legacy string)",    { id: "s2", team: "Carolina Haboba, Adam Yanke" }],
    ["PI",                      { id: "s3", pi: "Carolina Haboba" }],
    ["top-level authors",       { id: "s4", authors: [{ fore: "Carolina", last: "Haboba" }] }],
    ["publication authors",     { id: "s5", publication: { authors: [{ fore: "Carolina", last: "Haboba" }] } }],
    ["publication authorList",  { id: "s6", publication: { authorList: "Haboba C, Yanke AB" } }],
    ["surname only in authors", { id: "s7", publication: { authors: [{ fore: "C", last: "Haboba" }] } }],
  ];
  for (const [label, s] of CASES) {
    ev(`state.studies = [${JSON.stringify(s)}]; state.tasks = [];`);
    const n = ev(`studiesVisibleTo(${JSON.stringify(RA)}).length`);
    check("  " + label + " counts as involved", n === 1, n);
  }

  console.log("\n-- Assigned a task counts, even with no name on the study --");
  ev(`state.studies = [{ id: "s8", title: "Nobody named", team: [] }];
      state.tasks = [{ id: "t1", studyId: "s8", assignees: ["Carolina Haboba"], title: "x" }];`);
  check("a task assignment grants the study", ev(`studiesVisibleTo(${JSON.stringify(RA)}).length`) === 1);
  ev(`state.tasks = [{ id: "t1", studyId: "s8", assignees: ["Someone Else"], title: "x" }];`);
  check("...but somebody else's task does not", ev(`studiesVisibleTo(${JSON.stringify(RA)}).length`) === 0);

  console.log("\n-- Not being on it means not seeing it --");
  ev(`state.studies = [{ id: "s9", team: ["Adam Yanke"], pi: "Adam Yanke",
        publication: { authorList: "Yanke AB, Cole BJ" } }]; state.tasks = [];`);
  check("an uninvolved study is excluded", ev(`studiesVisibleTo(${JSON.stringify(RA)}).length`) === 0);

  console.log("\n-- Nobody is grandfathered in --");
  // The rule I nearly shipped: "match nothing, see everything". It would hand a new RA all 397
  // studies on their first day, which is the opposite of the point.
  ev(`state.studies = [{id:"a"},{id:"b"},{id:"c"}]; state.tasks = [];`);
  check("a brand-new person with no involvement sees nothing",
    ev(`studiesVisibleTo({ id: "u-new", name: "Brand New", admin: false }).length`) === 0);

  console.log("\n-- A missing or useless name never matches everything --");
  // The worst possible bug here: an empty name matching every string on every study.
  ev(`state.studies = [{ id: "s10", team: ["Adam Yanke"], pi: "Adam Yanke" }]; state.tasks = [];`);
  [["empty", ""], ["whitespace", "   "], ["undefined", undefined], ["null", null]].forEach(([label, nm]) => {
    const n = ev(`studiesVisibleTo({ id: "x", name: ${JSON.stringify(nm)}, admin: false }).length`);
    check("  a " + label + " name sees nothing", n === 0, n);
  });
  check("no name produces no variants",
    ev(`nameVariantsFor({ name: "" }).length`) === 0);
  // A two-letter surname would match an enormous amount of text.
  check("a very short surname is not used alone",
    ev(`JSON.stringify(nameVariantsFor({ name: "Al Vu" }))`) === '["al vu"]',
    ev(`JSON.stringify(nameVariantsFor({ name: "Al Vu" }))`));
  check("a long surname is used alone",
    ev(`nameVariantsFor({ name: "Carolina Haboba" }).indexOf("haboba") >= 0`));

  console.log("\n-- Merged names still match --");
  // The roster reconciliation merged "Anu" into "Arnavaz(Anu) Hakimiyan". Two live studies are
  // written the old way. Ignoring aliases cost her both, and only showed up by comparing against
  // the dry run Adam had already approved.
  ev(`state.nameAliases = { "anu": "Arnavaz(Anu) Hakimiyan" };
      state.studies = [{ id: "al1", team: ["Anu"] }, { id: "al2", pi: "Anu" },
                       { id: "al3", team: ["Somebody Else"] }];
      state.tasks = [];`);
  const ANU = { id: "u-anu", name: "Arnavaz(Anu) Hakimiyan", admin: false };
  check("an alias of my name counts as me",
    ev(`studiesVisibleTo(${JSON.stringify(ANU)}).length`) === 2,
    ev(`studiesVisibleTo(${JSON.stringify(ANU)}).length`));
  check("the alias appears among my name variants",
    ev(`nameVariantsFor(${JSON.stringify(ANU)}).indexOf("anu") >= 0`));
  check("somebody else's alias is not mine",
    ev(`nameVariantsFor({ id: "x", name: "Daniel Shinn" }).indexOf("anu") < 0`));
  // An alias pointing at a different person must not leak that person's studies.
  ev(`state.nameAliases = { "anu": "Someone Entirely Else" };`);
  check("an alias that maps elsewhere grants nothing",
    ev(`studiesVisibleTo(${JSON.stringify(ANU)}).length`) === 0,
    ev(`studiesVisibleTo(${JSON.stringify(ANU)}).length`));
  ev(`state.nameAliases = {};`);

  console.log("\n-- Shapes that could throw instead of returning nothing --");
  const NASTY = [
    ["team is null",            { id: "n1", team: null }],
    ["team is a number",        { id: "n2", team: 42 }],
    ["authors is a string",     { id: "n3", authors: "Haboba C" }],
    ["authors has nulls",       { id: "n4", authors: [null, { fore: "Carolina", last: "Haboba" }] }],
    ["publication is null",     { id: "n5", publication: null }],
    ["publication.authors null",{ id: "n6", publication: { authors: null } }],
    ["everything missing",      { id: "n7" }],
  ];
  for (const [label, s] of NASTY) {
    let threw = null, n = null;
    ev(`state.studies = [${JSON.stringify(s)}]; state.tasks = [];`);
    try { n = ev(`studiesVisibleTo(${JSON.stringify(RA)}).length`); } catch (e) { threw = String(e); }
    check("  " + label + " doesn't throw", !threw, threw);
    check("    ...and returns a number", typeof n === "number", n);
  }

  console.log("\n-- The migration --");
  const MIG = path.join(PROJECT, "supabase", "migrations", "011-study-visibility.sql");
  if (!fs.existsSync(MIG)) {
    console.log("  (skipped — supabase/migrations isn't in this checkout)");
  } else {
    const sql = fs.readFileSync(MIG, "utf8");

    console.log("  -- only studies are narrowed --");
    check("the involvement test is gated on kind = 'study'",
      /kind <> 'study'\s*\n\s*or public\.sees_whole_lab/.test(sql),
      (sql.match(/kind <> 'study'[\s\S]{0,160}/) || [])[0]);
    check("meetings stay readable", /kind = 'meeting'/.test(sql));
    check("support access is unaffected", /has_support_access\(workspace\)/.test(sql));

    console.log("  -- the three ways to see a whole lab --");
    check("app admin", /sees_whole_lab[\s\S]{0,300}is_app_admin\(\)/.test(sql));
    check("lab admin of THIS lab", /is_lab_admin\(\) and ws = public\.my_workspace\(\)/.test(sql));
    check("section coverage — Carla", /my_division_workspaces\(\) w where w = ws/.test(sql));

    console.log("  -- both author lists, which the first dry run got wrong --");
    check("top-level authors are read", /d->'authors'/.test(sql));
    check("publication authors are read", /d->'publication'->'authors'/.test(sql));
    check("publication authorList is read", /d->'publication'->>'authorList'/.test(sql));
    check("team is read", /d->'team'/.test(sql));
    check("pi is read", /d->>'pi'/.test(sql));
    check("task assignment is read", /assigned_on_study/.test(sql));

    console.log("  -- defensive against jsonb type surprises --");
    // jsonb_array_elements on a non-array raises; inside a policy that makes the row vanish.
    const guards = (sql.match(/jsonb_typeof\(/g) || []).length;
    check("every array access is type-guarded", guards >= 5, guards);
    check("a legacy string team is still matched", /jsonb_typeof\(d->'team'\) = 'string'/.test(sql));

    console.log("  -- the name match can't degenerate --");
    check("a short surname is excluded in SQL too", /length\(x\) > 2/.test(sql));
    check("merged names are honoured in SQL too", /nameAliases/.test(sql));
    check("...matching on the alias TARGET, not any alias",
      /lower\(trim\(kv\.value\)\) = \(select n from me\)/.test(sql));
    check("writes are explicitly left alone", /does not change: insert, update and delete/i.test(sql));
    check("the measured dry-run numbers are recorded", /Chahla 66 of 397/.test(sql));
    check("it says how to roll back", /ROLLBACK:/.test(sql));
    check("it carries a VERIFY block", /VERIFY/.test(sql));
    check("verification covers Carla via coverage, not admin",
      /removing\s*\n?--\s*her app_admins row|via coverage, NOT via being an app admin/.test(sql));
    check("verification covers tasks on unreadable studies",
      /tasks on studies they\s*\n?--\s*cannot read/.test(sql));
    check("verification checks nobody gained access", /Nobody's study count went UP/.test(sql));
  }

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
