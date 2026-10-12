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
    // Pre-authenticated mock Supabase client — bootApp() signs itself in against this instead
    // of hitting the real network, so the app unlocks past the login screen immediately.
    win.supabase = { createClient: () => makeMockSupabase({ items: [] }) };
  }
});
const { window } = dom;

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  await wait(300);
  const doc = window.document;

  // Load sample data via Settings, then go to Worklist tab.
  const settingsBtn = doc.querySelector('button[data-tab="settings"]');
  settingsBtn.click();
  await wait(50);
  const loadSampleBtn = [...doc.querySelectorAll('button')].find(b => b.textContent.includes("Load Sample Data"));
  if (loadSampleBtn) { loadSampleBtn.click(); await wait(50); }
  if (window.confirm) window.confirm = () => true;

  const worklistBtn = doc.querySelector('button[data-tab="worklist"]');
  worklistBtn.click();
  await wait(50);

  const headers = [...doc.querySelectorAll('.wl thead th')].map(th => th.textContent);
  console.log("Worklist headers:", JSON.stringify(headers));

  const rows1 = [...doc.querySelectorAll('.wl tbody tr')].map(tr => tr.children[5].textContent.trim());
  console.log("Design column values (default sort):", JSON.stringify(rows1));

  // Click "Design" header to sort ascending
  const designTh = [...doc.querySelectorAll('.wl thead th')].find(th => th.textContent.startsWith("Design"));
  designTh.click();
  await wait(50);
  const rows2 = [...doc.querySelectorAll('.wl tbody tr')].map(tr => tr.children[5].textContent.trim());
  console.log("Design column after 1 click (asc):", JSON.stringify(rows2));

  designTh.click();
  await wait(50);
  const rows3 = [...doc.querySelectorAll('.wl tbody tr')].map(tr => tr.children[5].textContent.trim());
  console.log("Design column after 2 clicks (desc):", JSON.stringify(rows3));

  // Now check Studies tab design filter
  const studiesBtn = doc.querySelector('button[data-tab="studies"]');
  studiesBtn.click();
  await wait(50);
  const designFilter = doc.getElementById("design-filter");
  console.log("Design filter options:", designFilter ? [...designFilter.options].map(o => o.textContent) : "MISSING");

  // pick "Basic Science" option and confirm cards filtered
  const bsOption = [...designFilter.options].find(o => o.textContent.includes("Basic Science"));
  designFilter.value = bsOption.value;
  designFilter.dispatchEvent(new window.Event("change"));
  await wait(50);
  const cardTitles = [...doc.querySelectorAll('.study-row h3')].map(h => h.textContent);
  console.log("Filtered to Basic Science, cards shown:", JSON.stringify(cardTitles));

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
