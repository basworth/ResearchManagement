// Every write must carry the workspace stamp. Without it the real database rejects the row, so a
// missing stamp means "nothing saves" — the loudest possible failure, worth a test of its own.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const ME = "11111111-1111-1111-1111-111111111111";
const now = new Date().toISOString();
const mockItems = [
  { id: ME, kind: "profile", updated_at: now, workspace: "spine-singh",
    data: { id: ME, name: "Kern Singh", email: "kern@example.com", position: "Clinician",
            admin: false, reportsTo: "", alertEmail: "", linkedTo: "", alertEmailAsked: true, degreesAsked: true } }
];
const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items: mockItems, userId: ME, email: "kern@example.com" }) };
  }
});
const { window } = dom;
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);
const ev = c => window.eval(c);

(async () => {
  await wait(400);

  console.log("\n-- The app learns its lab from its own profile row --");
  check("picked up spine-singh, not the default", ev("myWorkspace") === "spine-singh", ev("myWorkspace"));

  console.log("\n-- Every write carries the stamp --");
  ev(`syncOnline = true; window.__d = pushItem("study", { id: "s-new", title: "Cervical disc arthroplasty outcomes",
      phase: "Concept", design: "Retrospective (Chart Review)", priority: "Medium" });`);
  await window.__d; await wait(100);
  const row = mockItems.find(r => r.id === "s-new");
  check("the new study reached the database", !!row);
  check("...stamped with this person's lab", row && row.workspace === "spine-singh", row && row.workspace);

  ev(`window.__d2 = pushItem("task", { id: "t-new", title: "Pull the imaging", studyId: "s-new",
      assignees: [], notes: "", done: false, due: "" });`);
  await window.__d2; await wait(100);
  check("tasks are stamped too", (mockItems.find(r => r.id === "t-new") || {}).workspace === "spine-singh");

  console.log("\n-- A bulk push is stamped as well --");
  ev(`window.__d3 = pushItem("study", { id: "s-bulk", title: "Bulk", phase: "Concept",
      design: "Retrospective (Chart Review)", priority: "Low" }, null, { merge: false });`);
  await window.__d3; await wait(100);
  check("the bulk path doesn't drop the stamp", (mockItems.find(r => r.id === "s-bulk") || {}).workspace === "spine-singh");

  console.log("\n-- Falls back to the original lab when there's nothing to read --");
  check("default is sports-yanke", /let myWorkspace = "sports-yanke"/.test(html));

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
