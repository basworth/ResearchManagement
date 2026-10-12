// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Admin tool that merges duplicate spellings of a person ("Chahla" -> "Jorge Chahla") across
// every record, and records the alias so migrate() can't resurrect the old spelling.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ADAM = "aaaaaaaa-0000-0000-0000-000000000001";
const JORGE = "bbbbbbbb-0000-0000-0000-000000000002";

const mockItems = [
  { id: "s1", kind: "study", data: { id: "s1", title: "Chahla PI Study", nickname: "", pi: "Chahla", team: ["Chahla", "Adam Yanke"],
      authors: ["Chahla", "Adam Yanke"], docs: [{ id: "d1", name: "draft.docx", label: "Draft", by: "Chahla", date: "2026-01-01", size: 10 }],
      design: "Prospective (Consented)", phase: "Concept", priority: "Medium", irb: "ORA-1", milestones: [] }, updated_at: now },
  { id: "s2", kind: "study", data: { id: "s2", title: "Multi PI", nickname: "", pi: "Adam Yanke, Chahla", team: [],
      design: "Prospective (Consented)", phase: "Concept", priority: "Medium", irb: "ORA-2", milestones: [] }, updated_at: now },
  { id: "s3", kind: "study", data: { id: "s3", title: "Untouched", nickname: "", pi: "Adam Yanke", team: ["Adam Yanke"],
      design: "Prospective (Consented)", phase: "Concept", priority: "Medium", irb: "ORA-3", milestones: [] }, updated_at: now },
  { id: "t1", kind: "task", data: { id: "t1", studyId: "s1", title: "Chase IRB", assignees: ["Chahla"], done: false, due: "" }, updated_at: now },
  { id: "t2", kind: "task", data: { id: "t2", studyId: "s1", title: "Both named", assignees: ["Chahla", "Jorge Chahla"], done: false, due: "" }, updated_at: now },
  { id: ADAM, kind: "profile", data: { id: ADAM, email: "adam.yanke@rushortho.com", name: "Adam Yanke", position: "Clinician", reportsTo: "", admin: true }, updated_at: now },
  { id: JORGE, kind: "profile", data: { id: JORGE, email: "jorge.chahla@rushortho.com", name: "Chahla", position: "Clinician", reportsTo: ADAM, admin: false }, updated_at: now },
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", data: { id: "00000000-0000-0000-0000-000000000001",
      names: ["Adam Yanke", "Chahla", "Jorge Chahla"], degrees: { "Chahla": ["MD"], "Jorge Chahla": ["PhD"] } }, updated_at: now }
];

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => {
      const c = makeMockSupabase({ items: mockItems.map(r => JSON.parse(JSON.stringify(r))) });
      c.auth.getSession = async () => ({ data: { session: { user: { id: ADAM, email: "adam.yanke@rushortho.com" } } }, error: null });
      return c;
    } };
  }
});
const { window } = dom, doc = window.document;
const wait = ms => new Promise(r => setTimeout(r, ms));
const S = (id) => JSON.parse(window.eval(`JSON.stringify(state.studies.find(s=>s.id==="${id}"))`));
const T = (id) => JSON.parse(window.eval(`JSON.stringify(state.tasks.find(t=>t.id==="${id}"))`));

(async () => {
  await wait(450);
  window.eval("syncOnline = true");
  check("Signed in as an admin", window.eval("isAdmin()") === true);

  console.log("\n-- Impact preview before touching anything --");
  const imp = JSON.parse(window.eval('JSON.stringify(nameMergeImpact("Chahla"))'));
  check("Counts the studies involved", imp.studies === 2, imp);
  check("Counts the tasks", imp.tasks === 2, imp);
  check("Counts uploads attributed to them", imp.docs === 1, imp);
  check("Nothing changed yet", S("s1").pi === "Chahla");

  console.log("\n-- The merge rewrites every field --");
  const res = JSON.parse(window.eval('JSON.stringify(mergeNames("Chahla", "Jorge Chahla"))'));
  await wait(150);
  check("PI rewritten", S("s1").pi === "Jorge Chahla", S("s1").pi);
  check("Team rewritten", S("s1").team.includes("Jorge Chahla") && !S("s1").team.includes("Chahla"), S("s1").team);
  check("Author list rewritten", S("s1").authors.includes("Jorge Chahla") && !S("s1").authors.includes("Chahla"), S("s1").authors);
  check("Upload attribution rewritten", S("s1").docs[0].by === "Jorge Chahla");
  check("A multi-name PI field keeps both people", S("s2").pi === "Adam Yanke, Jorge Chahla", S("s2").pi);
  check("Task assignee rewritten", T("t1").assignees[0] === "Jorge Chahla", T("t1").assignees);
  check("A task naming BOTH spellings collapses to one", T("t2").assignees.length === 1 && T("t2").assignees[0] === "Jorge Chahla", T("t2").assignees);
  check("An unrelated study is untouched", S("s3").pi === "Adam Yanke" && S("s3").team.length === 1);
  check("Reported what it changed", res.studies === 2 && res.tasks === 2, res);

  console.log("\n-- Roster, degrees and profile --");
  const roster = JSON.parse(window.eval("JSON.stringify(state.roster)"));
  check("Old spelling gone from the roster", !roster.includes("Chahla"), roster);
  check("Correct name present once", roster.filter(n => n === "Jorge Chahla").length === 1, roster);
  const deg = JSON.parse(window.eval("JSON.stringify(state.rosterDegrees)"));
  check("Degrees were re-keyed and unioned", deg["Jorge Chahla"].includes("MD") && deg["Jorge Chahla"].includes("PhD"), deg);
  check("...and the old key removed", !deg["Chahla"], deg);
  check("Their profile name was corrected",
    window.eval(`profileFor("${JORGE}").name`) === "Jorge Chahla");

  console.log("\n-- The alias is remembered, so migrate can't undo it --");
  check("Alias recorded", window.eval('state.nameAliases["chahla"]') === "Jorge Chahla");
  check("canonName now resolves it", window.eval('canonName("Chahla")') === "Jorge Chahla");
  check("...and still strips degrees on top", window.eval('canonName("Chahla MD")') === "Jorge Chahla");
  // The real regression risk: migrate() rebuilds the roster from raw fields.
  window.eval("migrate(); render();");
  await wait(120);
  check("Roster still clean after a full migrate",
    !JSON.parse(window.eval("JSON.stringify(state.roster)")).includes("Chahla"),
    window.eval("JSON.stringify(state.roster)"));

  console.log("\n-- Filtering by the corrected name finds the work --");
  check("studyInvolvesPerson matches the merged study",
    window.eval('studyInvolvesPerson(state.studies.find(s=>s.id==="s1"), "Jorge Chahla")') === true);
  check("...and the multi-PI study", window.eval('studyInvolvesPerson(state.studies.find(s=>s.id==="s2"), "Jorge Chahla")') === true);
  check("...but not an unrelated one", window.eval('studyInvolvesPerson(state.studies.find(s=>s.id==="s3"), "Jorge Chahla")') === false);

  console.log("\n-- Everything was pushed, not just changed locally --");
  const pushed = JSON.parse(window.eval(`JSON.stringify(sb.__items.filter(r => r.kind === "study").map(r => r.data.pi))`));
  check("Study rows synced with the new spelling", pushed.includes("Jorge Chahla"), pushed);
  check("Roster meta row carries the alias",
    window.eval('JSON.stringify((sb.__items.find(r=>r.kind==="meta")||{}).data.nameAliases)').includes("Jorge Chahla"));
  check("...and still carries degrees (a past bug dropped them)",
    window.eval('!!(sb.__items.find(r=>r.kind==="meta")||{}).data.degrees') === true);

  console.log("\n-- Guard rails --");
  check("Merging a name onto itself is refused", window.eval('mergeNames("Jorge Chahla","Jorge Chahla")') === null);
  check("A blank name is refused", window.eval('mergeNames("","Jorge Chahla")') === null);

  console.log("\n-- The Settings tool is admin-only --");
  window.eval('tab = "settings"; render();');
  await wait(150);
  check("Merge controls shown to an admin", !!doc.getElementById("merge-from") && !!doc.getElementById("merge-go"));
  check("Already-merged list shown", doc.getElementById("main").innerHTML.includes("ALREADY MERGED"));
  check("Preview text present", !!doc.getElementById("merge-preview"));

  const d2 = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => {
        const c = makeMockSupabase({ items: mockItems.map(r => JSON.parse(JSON.stringify(r))) });
        c.auth.getSession = async () => ({ data: { session: { user: { id: JORGE, email: "jorge.chahla@rushortho.com" } } }, error: null });
        return c;
      } };
    }
  });
  await wait(450);
  d2.window.eval('syncOnline = true; tab = "settings"; render();');
  await wait(150);
  check("A non-admin sees no merge controls", !d2.window.document.getElementById("merge-from"));
  const before = d2.window.eval('state.studies.find(s=>s.id==="s1").pi');
  check("...and calling it directly does nothing", d2.window.eval('mergeNames("Chahla","Jorge Chahla")') === null);
  check("...leaving records alone", d2.window.eval('state.studies.find(s=>s.id==="s1").pi') === before);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
