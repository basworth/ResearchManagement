// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const now = new Date().toISOString();
const mockItems = [
  { id: "s-adam", kind: "study", data: { id: "s-adam", title: "Adam Only Study", nickname: "AdamOnly", pi: "Yanke", team: [], design: "Prospective (Consented)", phase: "Concept", priority: "Medium", irb: "ORA-1", milestones: [] }, updated_at: now },
  { id: "s-navya", kind: "study", data: { id: "s-navya", title: "Navya Only Study", nickname: "NavyaOnly", pi: "Chahla", team: ["Navya"], design: "Retrospective (Non-Consented)", phase: "Analysis", priority: "Low", irb: "ORA-2", milestones: [] }, updated_at: now },
  { id: "s-other", kind: "study", data: { id: "s-other", title: "Nobody Else Study", nickname: "Orphan", pi: "Chahla", team: ["Cade"], design: "Basic Science / Exempt", phase: "Concept", priority: "Low", irb: "ORA-3", milestones: [] }, updated_at: now }
];

const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items: mockItems }) };
  }
});
const { window } = dom;

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
const setMe = (name) => window.eval(`upsertProfile(${JSON.stringify(name)})`);

(async () => {
  await wait(300);
  const doc = window.document;
  const studiesBtn = doc.querySelector('button[data-tab="studies"]');
  const worklistBtn = doc.querySelector('button[data-tab="worklist"]');

  // ---------- Who counts as an admin ----------
  console.log("Adam Yanke is an admin:", window.eval('ADMIN_NAMES.indexOf("Adam Yanke") >= 0'));
  console.log("William Lee is an admin:", window.eval('ADMIN_NAMES.indexOf("William Lee") >= 0'));
  console.log("Thomas Turinske is an admin:", window.eval('ADMIN_NAMES.indexOf("Thomas Turinske") >= 0'));
  console.log("Exactly three admins, nobody else:", window.eval("ADMIN_NAMES.length") === 3);
  console.log("Legacy 'TJ' spellings resolve to Thomas Turinske:", window.eval('canonName("TJ") === "Thomas Turinske" && canonName("TJ T") === "Thomas Turinske"'));

  // ---------- Admin: sees everything without being named ----------
  setMe("Adam Yanke");
  await wait(60);
  console.log("Adam is recognised as admin:", window.eval("isAdmin()") === true);
  console.log("Admin's visible set is every study:", window.eval("visibleStudies().length") === 3);
  console.log("Admin can open a study he's not named on:", window.eval('canSeeStudy(state.studies.find(function(s){return s.id==="s-other"}))') === true);

  // ...but his default view is still just his own projects
  studiesBtn.click();
  await wait(60);
  console.log("Adam's Who filter defaults to 'mine':", window.eval('personFilter') === "mine");
  const titlesOnScreen = () => [...doc.querySelectorAll('.study-row')]
    .map(c => window.eval(`(state.studies.find(s => s.id === ${JSON.stringify(c.getAttribute("data-study"))}) || {}).title`));
  const adamDefaultTitles = titlesOnScreen();
  console.log("Adam defaults to seeing only his own project:", adamDefaultTitles.length === 1 && adamDefaultTitles[0] === "Adam Only Study");
  console.log("Admin gets the Who picker to look wider:", !!doc.getElementById("person-filter"));

  const sel = doc.getElementById("person-filter");
  sel.value = "all";
  sel.dispatchEvent(new window.Event("change"));
  await wait(60);
  console.log("Switching to All Projects reveals all three:", doc.querySelectorAll('[data-study]').length === 3);

  // ---------- Non-admin: only their own projects, no Who picker ----------
  setMe("Navya");
  await wait(60);
  window.eval('personFilter = "mine"');
  console.log("Navya is not an admin:", window.eval("isAdmin()") === false);
  console.log("Non-admin's visible set is only her project:", window.eval("visibleStudies().length") === 1);

  studiesBtn.click();
  await wait(60);
  const navyaTitles = titlesOnScreen();
  console.log("Non-admin sees only her own project:", navyaTitles.length === 1 && navyaTitles[0] === "Navya Only Study");
  console.log("Non-admin has no Who picker to widen the view:", !doc.getElementById("person-filter"));

  // Even forcing the filter to "all" cannot widen a non-admin's view
  window.eval('personFilter = "all"');
  studiesBtn.click();
  await wait(60);
  console.log("Forcing personFilter='all' still shows only her project:", doc.querySelectorAll('[data-study]').length === 1);
  window.eval('personFilter = "mine"');

  // Worklist is restricted the same way
  worklistBtn.click();
  await wait(60);
  console.log("Non-admin's Worklist is restricted too:", doc.querySelectorAll('.wl tbody tr').length === 1);

  // Deep-linking into someone else's study bounces back
  window.eval('openStudy("s-other"); tab = "studies"; render();');
  await wait(80);
  console.log("Non-admin can't deep-link into a project she's not on:", window.eval("detailStudyId") === null);
  console.log("Bounced back to the Studies list:", doc.getElementById("page-title").textContent === "Studies");
  console.log("canSeeStudy() denies the unshared project:", window.eval('canSeeStudy(state.studies.find(function(s){return s.id==="s-other"}))') === false);

  // ---------- The other two admins ----------
  setMe("William Lee");
  await wait(60);
  console.log("William Lee sees every study without being named:", window.eval("isAdmin() && visibleStudies().length") === 3);
  setMe("Thomas Turinske");
  await wait(60);
  console.log("Thomas Turinske sees every study without being named:", window.eval("isAdmin() && visibleStudies().length") === 3);

  // Admin badge surfaces in Settings
  doc.querySelector('button[data-tab="settings"]').click();
  await wait(60);
  console.log("Settings tells an admin they have full access:", doc.getElementById("main").innerHTML.includes("Admin — you can see and edit every project"));

  setMe("Navya");
  await wait(60);
  doc.querySelector('button[data-tab="settings"]').click();
  await wait(60);
  console.log("Non-admin sees no admin badge:", !doc.getElementById("main").innerHTML.includes("Admin — you can see and edit"));

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
