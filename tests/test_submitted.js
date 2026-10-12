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

  const studiesBtn = doc.querySelector('button[data-tab="studies"]');
  studiesBtn.click();
  await wait(50);

  // Open the first study card for editing
  const card = doc.querySelector('.study-row');
  card.click();
  await wait(50);
  const editBtn = doc.getElementById("edit-study-btn");
  editBtn.click();
  await wait(50);

  // The journal used to live on the study form as #journal-row, shown or hidden by phase. It
  // moved onto the Manuscript section of the study page (#ms-journal) in the document
  // consolidation, so there is no row on the form to check here any more. Phase behaviour below
  // is still the point of this test; the journal field itself is covered by
  // test_journal_decision.js.
  console.log("journal-row retired from the study form:", doc.getElementById("journal-row") === null);

  const phaseSel = doc.getElementById("f-phase");
  phaseSel.value = "Submitted";
  phaseSel.dispatchEvent(new window.Event("change"));
  await wait(20);
  doc.getElementById("sheet-save").click();
  await wait(80);

  // Journal, submitted date and tracking ID moved off the study form and onto the Manuscript
  // section of the study page, where they are always editable rather than gated behind a phase.
  console.log("Phase is now Submitted:", window.eval(`studyById(detailStudyId).phase`) === "Submitted");
  console.log("Journal field on the Manuscript section:", !!doc.getElementById("ms-journal"));
  console.log("Submitted-on field present:", !!doc.getElementById("ms-submitted-date"));
  console.log("Tracking ID field present:", !!doc.getElementById("ms-tracking-id"));

  const trackBox = doc.getElementById("ms-tracking-id");
  trackBox.value = "AJSM-26-0456";
  trackBox.dispatchEvent(new window.Event("change"));
  await wait(80);
  console.log("Tracking ID persists on the study:",
    window.eval(`studyById(detailStudyId).journalTrackingId`) === "AJSM-26-0456");

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
