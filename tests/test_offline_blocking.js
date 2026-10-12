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
    // Mock with no active session, so bootApp() shows the login screen and syncOnline stays
    // false without needing a real network round-trip - matches the "never connected" baseline
    // this test exercises, and avoids the real 12s+15s retry loop hanging the test process.
    win.supabase = { createClient: () => {
      const client = makeMockSupabase({ items: [], session: null });
      win.__mockSetSession = client.__setSession;   // so the test can "sign in" partway through
      return client;
    } };
  }
});
const { window } = dom;

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  await wait(300);
  const doc = window.document;

  // Sanity: confirm the gate helpers exist and default to offline (no Team Sync configured in
  // this sandbox — matches the real "never connected Team Sync" state on a fresh device).
  console.log("canEditData() defaults to false (no Team Sync in sandbox):", window.eval("canEditData()") === false);

  const settingsBtn = doc.querySelector('button[data-tab="settings"]');
  settingsBtn.click();
  await wait(50);
  const loadSampleBtn = [...doc.querySelectorAll('button')].find(b => b.textContent.includes("Load Sample Data"));
  if (loadSampleBtn) { loadSampleBtn.click(); await wait(50); } // Load Sample Data itself is NOT gated (test/demo convenience)

  const studiesBtn = doc.querySelector('button[data-tab="studies"]');
  studiesBtn.click();
  await wait(50);
  const studyCountBefore = doc.querySelectorAll('[data-study]').length;

  // --- Try to add a new study via the "+" button (Studies tab calls openStudyForm(null) directly) ---
  const addBtn = doc.getElementById("add-btn");
  console.log("Found the floating add button:", !!addBtn);
  addBtn.click();
  await wait(50);
  console.log("New Study form did NOT open while offline (no #f-title field):", !doc.getElementById("f-title"));
  console.log("Study count unchanged after blocked add attempt:", doc.querySelectorAll('[data-study]').length === studyCountBefore);

  // --- Try to edit an existing study while offline ---
  const card = doc.querySelector('.study-row');
  const studyTitleBefore = card.querySelector('h3').textContent;
  card.click();
  await wait(50);
  const editBtn = doc.getElementById("edit-study-btn");
  editBtn.click();
  await wait(50);
  console.log("Edit Study form did NOT open while offline:", !doc.getElementById("f-title"));

  // --- Try to delete that study while offline (confirm() is mocked to always return true) ---
  const delBtn = doc.getElementById("del-study-btn");
  delBtn.click();
  await wait(50);
  // Already on the "studies" tab (just in detail view) — clicking the tab button again is a
  // documented no-op (it only resets detailStudyId when switching AWAY from "studies"), so use
  // the in-page back button to actually return to the list.
  doc.getElementById("back-btn").click();
  await wait(50);
  const studyCountAfterDelAttempt = doc.querySelectorAll('[data-study]').length;
  console.log("Study NOT deleted while offline:", studyCountAfterDelAttempt === studyCountBefore);

  // --- Try an inline sub-edit (add a milestone) while offline: should not appear after refresh ---
  const card2 = [...doc.querySelectorAll('.study-row')].find(c => c.querySelector('h3').textContent === studyTitleBefore);
  card2.click();
  await wait(50);
  const msNameInput = doc.getElementById("ms-name");
  let milestoneBlockedOk = true;
  if (msNameInput) {
    const msCountBefore = doc.querySelectorAll('.milestone-row').length;
    msNameInput.value = "Should not persist";
    const msDateInput = doc.getElementById("ms-date");
    if (msDateInput) msDateInput.value = "2026-12-01";
    const msAddBtn = doc.getElementById("ms-add");
    if (msAddBtn) {
      msAddBtn.click();
      await wait(50);
      // Blocked upsertStudy() returns before render(), so the DOM shouldn't show a new row.
      milestoneBlockedOk = doc.querySelectorAll('.milestone-row').length === msCountBefore;
    }
  }
  console.log("Inline milestone add blocked while offline (or control not present to test):", milestoneBlockedOk);
  doc.getElementById("back-btn").click();
  await wait(50);

  // --- Now simulate a healthy Team Sync connection and confirm editing is allowed ---
  // The stand-in database refuses every write without a session, exactly as the real row-level
  // security does. Flipping syncOnline alone leaves the app willing to save and the database
  // still refusing, so the save under test was being rejected by the stand-in, not by the app.
  window.eval("syncOnline = true");
  window.__mockSetSession({ user: { id: "test-user", email: "test@example.com" } });
  console.log("canEditData() now true after simulating a live connection:", window.eval("canEditData()") === true);

  addBtn.click();
  await wait(50);
  const titleField = doc.getElementById("f-title");
  console.log("New Study form DOES open once online:", !!titleField);
  if (titleField) {
    titleField.value = "Online Test Study";
    doc.getElementById("f-pi").value = "TestPI";
    const saveBtn = doc.getElementById("sheet-save");
    saveBtn.click();
    await wait(50);
    studiesBtn.click();
    await wait(50);
    const allSegBtn = [...doc.querySelectorAll('.seg button')].find(b => b.textContent === "All");
    if (allSegBtn) { allSegBtn.click(); await wait(50); }
    // Assert against the study list's rendered text and the stored record, not a `[data-study] h3`
    // selector — the study card's markup has changed since this was written, so that selector
    // matched nothing and reported a save failure that never happened.
    const savedInState = window.eval(`state.studies.some(s => s.title === "Online Test Study")`);
    const onScreen = doc.getElementById("main").textContent.includes("Online Test Study");
    console.log("New study actually saved once online:", savedInState && onScreen);
  }

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
