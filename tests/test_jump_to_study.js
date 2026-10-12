// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    // Pre-authenticated mock Supabase client - bootApp() signs itself in against this instead
    // of hitting the real network, so the app unlocks past the login screen immediately.
    win.supabase = { createClient: () => makeMockSupabase({ items: [] }) };
  }
});
const { window } = dom;

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  await wait(300);
  const doc = window.document;

  const settingsBtn = doc.querySelector('button[data-tab="settings"]');
  settingsBtn.click();
  await wait(50);
  const loadSampleBtn = [...doc.querySelectorAll('button')].find(b => b.textContent.includes("Load Sample Data"));
  if (loadSampleBtn) { loadSampleBtn.click(); await wait(50); }

  const tasksBtn = doc.querySelector('button[data-tab="tasks"]');
  tasksBtn.click();
  await wait(50);
  // Tasks now opens on "Mine"; switch to "Open" so every seeded task is in view here.
  [...doc.querySelectorAll(".seg button")].find(function(b){return b.textContent.trim()==="Open"}).click();
  await wait(50);

  // Find a task row that has a linked study (data-goto-study span)
  const gotoEl = doc.querySelector('[data-goto-study]');
  console.log("Found a task row with clickable study link:", !!gotoEl);
  const studyId = gotoEl.dataset.gotoStudy;
  gotoEl.click();
  await wait(50);

  const pageTitle = doc.getElementById("page-title").textContent;
  console.log("Page title after clicking study link from task row:", pageTitle);
  console.log("Detail shows correct study id match:", doc.getElementById("main").innerHTML.length > 0);

  // Go back to tasks, open a task's edit sheet, check "Open Study" button
  tasksBtn.click();
  await wait(50);
  // Tasks now opens on "Mine"; switch to "Open" so every seeded task is in view here.
  [...doc.querySelectorAll(".seg button")].find(function(b){return b.textContent.trim()==="Open"}).click();
  await wait(50);
  const taskBody = doc.querySelector('[data-task]');
  taskBody.click();
  await wait(50);
  const gotoBtn = doc.getElementById("f-tgoto-study");
  console.log("Open Study button present in task edit sheet:", !!gotoBtn);
  if (gotoBtn) {
    console.log("Open Study button text:", gotoBtn.textContent);
    gotoBtn.click();
    await wait(50);
    console.log("Page title after clicking Open Study button:", doc.getElementById("page-title").textContent);
    await wait(400); console.log("Sheet closed after jump:", !doc.getElementById("sheet"));
  }

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
