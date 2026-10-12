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
    win.supabase = { createClient: () => makeMockSupabase({ items: [], session: null }) };
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

  // --- Tasks: New Task form should not open while offline ---
  const tasksBtn = doc.querySelector('button[data-tab="tasks"]');
  tasksBtn.click();
  await wait(50);
  // Tasks now opens on "Mine"; switch to "Open" so every seeded task is in view here.
  [...doc.querySelectorAll(".seg button")].find(function(b){return b.textContent.trim()==="Open"}).click();
  await wait(50);
  const taskCountBefore = doc.querySelectorAll('.task-row[data-open-task], .task-row').length;
  doc.getElementById("add-btn").click();
  await wait(50);
  console.log("New Task form did NOT open while offline:", !doc.getElementById("f-ttitle"));

  // --- Meetings: Settings > Add Meeting Deadline should not open while offline ---
  settingsBtn.click();
  await wait(50);
  const addMeetingBtn = doc.getElementById("add-meeting-btn");
  addMeetingBtn.click();
  await wait(50);
  console.log("New Deadline form did NOT open while offline:", !doc.getElementById("f-mname"));

  // --- Linking: opening the "Link Deadlines" sheet from a study should be blocked offline ---
  const studiesBtn = doc.querySelector('button[data-tab="studies"]');
  studiesBtn.click();
  await wait(50);
  const card = doc.querySelector('.study-row');
  card.click();
  await wait(50);
  const linkAbsSelect = doc.getElementById("link-existing-dl-abs");
  console.log("Abstract-linking dropdown still visible (read-only browse allowed):", !!linkAbsSelect);
  if (linkAbsSelect) {
    const meetingOption = [...linkAbsSelect.options].find(o => o.value);
    if (meetingOption) {
      const before = doc.getElementById("main").innerHTML;
      linkAbsSelect.value = meetingOption.value;
      linkAbsSelect.dispatchEvent(new window.Event("change"));
      await wait(50);
      // toggleStudyLink() should have been blocked; nothing should change (no new unlink button
      // appearing where none did before, since linking is the same as adding a linked chip).
      const unlinkCountBefore = (before.match(/data-unlink-meeting/g) || []).length;
      const unlinkCountAfter = (doc.getElementById("main").innerHTML.match(/data-unlink-meeting/g) || []).length;
      console.log("Linking a deadline blocked while offline (unlink-button count unchanged):", unlinkCountBefore === unlinkCountAfter);
    }
  }

  // --- Now simulate online and confirm task creation works ---
  window.eval("syncOnline = true");
  tasksBtn.click();
  await wait(50);
  // Tasks now opens on "Mine"; switch to "Open" so every seeded task is in view here.
  [...doc.querySelectorAll(".seg button")].find(function(b){return b.textContent.trim()==="Open"}).click();
  await wait(50);
  doc.getElementById("add-btn").click();
  await wait(50);
  const ttitle = doc.getElementById("f-ttitle");
  console.log("New Task form DOES open once online:", !!ttitle);
  if (ttitle) {
    ttitle.value = "Online Test Task";
    doc.getElementById("sheet-save").click();
    await wait(50);
    tasksBtn.click();
    await wait(50);
    // Tasks now opens on "Mine"; the new task has no assignee, so view "Open" to see it.
    [...doc.querySelectorAll(".seg button")].find(b => b.textContent.trim() === "Open").click();
    await wait(50);
    console.log("New task actually saved once online:", doc.getElementById("main").innerHTML.includes("Online Test Task"));
  }

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
