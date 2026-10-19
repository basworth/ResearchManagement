// Divisions above labs — 19 Oct 2026.
//
// Carla covers all of Sports. Instead of a lab_members row per Sports lab — one of which somebody
// will eventually forget to add — she is a member of the division, and my_workspaces() expands
// that into every lab inside it, including labs created later.
//
// Two halves have to agree. The database decides the truth (migration 009), and the client
// filters what it pulls. This file tests the client half and the SQL half separately:
//
//   1. labsIAmIn() must include division labs, must survive the coverage tables being absent,
//      and must never drop the person's own lab — losing that is a lockout.
//
//   2. The migration must not widen anybody's access on the day it runs, must not grant admin,
//      and must keep its write policies admin-only. A lab admin who could add their own lab to a
//      division would be handing their studies to whoever covers it.
//
// The privacy rule this protects: Adam is in no division. Covering Sports is an administrative
// job, and his standing instruction is that he should not see other PIs' studies at all.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const USER = "u-carla";
const now = new Date().toISOString();
const profile = () => ({
  id: USER, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: { id: USER, email: "carla@example.com", name: "Carla", position: "Coordinator",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true,
    tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: false },
});

function boot() {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items: [profile()] }) };
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

  console.log("\n-- With no division, nothing changes --");
  ev('myWorkspace = "sports-yanke"; myLabs = []; myDivisions = []; divisionLabs = {};');
  check("you are in your own lab", JSON.parse(ev("JSON.stringify(labsIAmIn())")).join() === "sports-yanke",
    ev("JSON.stringify(labsIAmIn())"));
  check("labsViaDivisions is empty", ev("labsViaDivisions().length") === 0);

  console.log("\n-- Covering a division adds every lab in it --");
  ev(`myDivisions = ["sports"];
      divisionLabs = { sports: ["sports-yanke", "sports-chahla", "sports-cole"] };`);
  const mine = JSON.parse(ev("JSON.stringify(labsIAmIn())"));
  check("all three Sports labs are reachable", mine.length === 3, mine);
  ["sports-yanke", "sports-chahla", "sports-cole"].forEach(ws =>
    check("  " + ws, mine.indexOf(ws) >= 0, mine));

  console.log("\n-- A lab added to the division later needs no change to the person --");
  ev('divisionLabs.sports.push("sports-verma");');
  check("the new lab appears", JSON.parse(ev("JSON.stringify(labsIAmIn())")).indexOf("sports-verma") >= 0);

  console.log("\n-- A lab in no division stays invisible --");
  check("spine-singh is not reachable",
    JSON.parse(ev("JSON.stringify(labsIAmIn())")).indexOf("spine-singh") < 0);

  console.log("\n-- Covering two divisions is additive, with no duplicates --");
  ev(`myDivisions = ["sports", "spine"];
      divisionLabs = { sports: ["sports-yanke", "sports-chahla"], spine: ["spine-singh", "sports-chahla"] };`);
  const both = JSON.parse(ev("JSON.stringify(labsIAmIn())"));
  check("three distinct labs", both.length === 3, both);
  check("the shared lab appears once",
    both.filter(x => x === "sports-chahla").length === 1, both);

  console.log("\n-- Your own lab is never lost --");
  // The failure that would be hardest to diagnose: coverage data arrives, and somehow replaces
  // rather than extends the person's own membership.
  ev('myWorkspace = "sports-yanke"; myLabs = []; myDivisions = ["spine"]; divisionLabs = { spine: ["spine-singh"] };');
  check("own lab still present", JSON.parse(ev("JSON.stringify(labsIAmIn())")).indexOf("sports-yanke") >= 0,
    ev("JSON.stringify(labsIAmIn())"));

  console.log("\n-- Missing or broken coverage data degrades to lab membership --");
  // These tables may not exist yet on an instance where 009 hasn't run. That is normal, and the
  // safe direction to fail in is seeing too little.
  const JUNK = [
    ["empty arrays", 'myDivisions = []; divisionLabs = {};'],
    ["a division with no labs", 'myDivisions = ["sports"]; divisionLabs = {};'],
    ["a division whose entry is null", 'myDivisions = ["sports"]; divisionLabs = { sports: null };'],
    ["a division not in the map", 'myDivisions = ["ghost"]; divisionLabs = { sports: ["a"] };'],
  ];
  for (const [name, setup] of JUNK) {
    let threw = null, got = null;
    try { ev('myWorkspace = "sports-yanke"; myLabs = [];' + setup); got = JSON.parse(ev("JSON.stringify(labsIAmIn())")); }
    catch (e) { threw = String(e); }
    check("  " + name + " doesn't throw", !threw, threw);
    check("    ...and still returns the own lab", !threw && got.join() === "sports-yanke", got);
  }

  console.log("\n-- The migration --");
  const MIG = path.join(PROJECT, "supabase", "migrations", "009-divisions.sql");
  if (!fs.existsSync(MIG)) {
    // CI checks out without supabase/. Skipping is correct; silently passing would not be.
    console.log("  (skipped — supabase/migrations isn't in this checkout)");
  } else {
    const sql = fs.readFileSync(MIG, "utf8");
    check("my_workspaces keeps its first two branches",
      /select workspace from public\.lab_members where user_id = auth\.uid\(\)/.test(sql)
      && /kind = 'profile' and i\.id = auth\.uid\(\)/.test(sql));
    check("...and gains the division branch",
      /union\s+select \* from public\.my_division_workspaces\(\)/.test(sql));
    check("the expansion joins coverage to labs through the section",
      /from public\.division_coverage dc[\s\S]{0,200}join public\.lab_divisions ld on ld\.division = dc\.division/.test(sql));
    check("...filtered to the caller", /where dc\.user_id = auth\.uid\(\)/.test(sql));

    // Writable only by an app admin. This is the whole security story of the feature.
    ["divisions", "lab_divisions", "division_coverage"].forEach(t => {
      check("  " + t + " has RLS enabled",
        new RegExp("alter table public\\." + t + "\\s+enable row level security").test(sql));
      const write = new RegExp("create policy " + t + "_write[\\s\\S]{0,200}?is_app_admin\\(\\)[\\s\\S]{0,80}?is_app_admin\\(\\)");
      check("  " + t + " is writable only by an app admin", write.test(sql));
    });

    check("no coverage rows are seeded", !/insert into public\.division_coverage/.test(sql),
      (sql.match(/insert into public\.division_coverage[\s\S]{0,120}/) || [])[0]);
    check("the migration touches no rows in items", !/update public\.items|delete from public\.items/.test(sql));
    check("it does not grant admin to anyone",
      !/insert into public\.app_admins|create or replace function public\.is_app_admin/.test(sql));
    check("it says how to roll back", /ROLLBACK:/.test(sql));
    check("it carries a VERIFY block", /VERIFY/.test(sql));
    check("Sports exists and contains the one real lab",
      /insert into public\.divisions \(key, name\) values \('sports'/.test(sql)
      && /values \('sports-yanke', 'sports'\)/.test(sql));
    check("every seed is idempotent",
      (sql.match(/on conflict/g) || []).length >= 2, (sql.match(/on conflict/g) || []).length);
  }

  console.log("\n-- The client mirrors the server, and says so --");
  check("labsIAmIn folds in division labs", /labsViaDivisions\(\)\.forEach/.test(html));
  check("coverage is loaded with lab membership", /loadLabMembership[\s\S]{0,900}?loadDivisionCoverage\(\)/.test(html));
  check("a coverage failure clears rather than guesses",
    /division coverage unavailable[\s\S]{0,160}myDivisions = \[\]/.test(html));
  check("the invite box asks what section they're in", /What section are they in\?/.test(html));
  check("...and it is a label, not a grant", /doesn't give anyone access to their lab/.test(html));
  check("...defaulting to unset", /<option value="">Not sure yet/.test(html));
  check("the division is filed only after the invite succeeds",
    /out\.ok && division && extra && extra\.workspace/.test(html));
  check("a failure to file it doesn't read as a failed invite",
    /Invite sent, but[\s\S]{0,80}wasn't added to/.test(html));

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
