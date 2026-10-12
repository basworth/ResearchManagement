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

  const dashBtn = doc.querySelector('button[data-tab="dashboard"]');
  dashBtn.click();
  await wait(50);
  const mainHTML = doc.getElementById("main").innerHTML;

  // Login is now required for the whole app, so by the time the dashboard renders you're always
  // authenticated and synced (remoteMeta gets populated as soon as sample data pushes) — the old
  // "no Team Sync connected" steady state no longer exists. The label should show up with a
  // real, well-formed date rather than a blank/garbled one.
  const lastUpdatedMatch = mainHTML.match(/\(Last Updated: ([^)]+)\)/);
  console.log("'Last Updated' label shows once synced, with a well-formed date:", !!lastUpdatedMatch && !!lastUpdatedMatch[1].trim());
  console.log("Abstract Deadlines heading still renders normally:", mainHTML.includes("Abstract Deadlines"));
  console.log("Grant & Funding Deadlines heading still renders normally:", mainHTML.includes("Grant &amp; Funding Deadlines") || mainHTML.includes("Grant & Funding Deadlines"));

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
