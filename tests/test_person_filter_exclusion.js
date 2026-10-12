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

  doc.getElementById("me-name").value = "Chen";
  doc.getElementById("me-name").dispatchEvent(new window.Event("change"));
  await wait(50);

  const studiesBtn = doc.querySelector('button[data-tab="studies"]');
  studiesBtn.click();
  await wait(50);
  studiesBtn.click(); // studyFilter default "Active" already; ensure "All" to include Published study too
  const allSegBtn = [...doc.querySelectorAll('.seg button')].find(b => b.textContent === "All");
  allSegBtn.click();
  await wait(50);

  const mineCount = doc.querySelectorAll('[data-study]').length;
  console.log("Chen (team member on 1 of 5 sample studies) 'Mine' filter shows exactly 1 study:", mineCount === 1, `(got ${mineCount})`);

  // Chen isn't an admin, so there's no Who picker and no way to widen past her own projects.
  console.log("Non-admin gets no Who picker:", !doc.getElementById("person-filter"));

  // An admin, by contrast, can switch to All Projects and see everything.
  window.eval('upsertProfile("Adam Yanke")');
  await wait(50);
  studiesBtn.click();
  await wait(50);
  [...doc.querySelectorAll('.seg button')].find(b => b.textContent === "All").click();
  await wait(50);
  const personSelect = doc.getElementById("person-filter");
  console.log("Admin gets the Who picker:", !!personSelect);
  personSelect.value = "all";
  personSelect.dispatchEvent(new window.Event("change"));
  await wait(50);
  const allCount = doc.querySelectorAll('[data-study]').length;
  console.log("All Projects shows all 5 sample studies:", allCount === 5, `(got ${allCount})`);

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
