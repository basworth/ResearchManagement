// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// A non-admin saving their own profile must not revert org-chart fields an admin set while
// their tab was open — the profile-row cousin of the ICRS deadline-link loss.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const ME = "user-1";
const now = new Date().toISOString();
// What the tab holds: a profile from before the admin touched it.
const staleProfile = { id: ME, email: "divesh@example.com", name: "Divesh Sachdev",
  position: "", reportsTo: "", alertEmail: "", alertEmailAsked: true, linkedTo: "" };
const mockItems = [{ id: ME, kind: "profile", updated_at: now, data: JSON.parse(JSON.stringify(staleProfile)) }];

const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items: mockItems, userId: ME, email: "divesh@example.com" }) };
  }
});
const { window } = dom;
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);
const ev = code => window.eval(code);

(async () => {
  await wait(400);

  // The admin, on another device, places this person on the org chart. The tab never hears of it.
  const row = mockItems.find(r => r.id === ME);
  row.data = Object.assign({}, row.data, { position: "Research Coordinator", reportsTo: "user-boss", admin: false });
  row.updated_at = new Date(Date.now() + 1000).toISOString();

  console.log("\n-- A non-admin saving their own profile --");
  ev(`currentUser = { id: ${JSON.stringify(ME)}, email: "divesh@example.com" };
      if (!state.profiles.some(p => p.id === ${JSON.stringify(ME)})) state.profiles.push(${JSON.stringify(staleProfile)});
      window.__done = (async () => { upsertProfile("Divesh Sachdev", { alertEmail: "divesh.home@example.com" }); })();`);
  await window.__done; await wait(250);

  const saved = mockItems.find(r => r.id === ME).data;
  check("their own change is saved", saved.alertEmail === "divesh.home@example.com", saved.alertEmail);
  check("the admin's position survives", saved.position === "Research Coordinator", saved.position);
  check("the admin's reporting line survives", saved.reportsTo === "user-boss", saved.reportsTo);

  console.log("\n-- An admin may still set those fields --");
  ev(`state.profiles.find(p => p.id === ${JSON.stringify(ME)}).admin = true;`);
  ev(`window.__done2 = (async () => { updateProfileFields(${JSON.stringify(ME)}, { position: "Research Manager", reportsTo: "user-other" }); })();`);
  await window.__done2; await wait(250);
  const after = mockItems.find(r => r.id === ME).data;
  check("the admin's new position is written", after.position === "Research Manager", after.position);
  check("...and the new reporting line too", after.reportsTo === "user-other", after.reportsTo);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
