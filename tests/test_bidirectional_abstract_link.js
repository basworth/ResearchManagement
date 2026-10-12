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

  // --- Direction 1: link from the STUDY side's Abstract Submissions > Abstract Deadlines dropdown ---
  const studiesBtn = doc.querySelector('button[data-tab="studies"]');
  studiesBtn.click();
  await wait(50);
  const card = doc.querySelector('.study-row');
  // The card's heading shows the nickname when a study has one; the deadline panel lists the
  // full title. Take the title from the record itself rather than from whichever the card shows.
  const studyId = card.getAttribute("data-study") || card.dataset.study;
  const studyTitle = window.eval(`(state.studies.find(s => s.id === ${JSON.stringify(studyId)}) || {}).title`);
  card.click();
  await wait(50);

  const absSelect = doc.getElementById("link-existing-dl-abs");
  const meetingOption = [...absSelect.options].find(o => o.value);
  const meetingId = meetingOption.value;
  const meetingLabel = meetingOption.textContent;
  console.log("Picked meeting to link from study side:", meetingLabel);
  absSelect.value = meetingId;
  absSelect.dispatchEvent(new window.Event("change"));
  await wait(50);

  // Now check the Dashboard's side panel (Abstract Deadlines board) for this meeting's "Linked Projects"
  const dashBtn = doc.querySelector('button[data-tab="dashboard"]');
  dashBtn.click();
  await wait(50);
  const dashHTML = doc.getElementById("main").innerHTML;
  console.log("Dashboard board shows the study as a linked project after linking from study side:", dashHTML.includes(studyTitle) && dashHTML.includes(`data-open-study`));

  // Expand the details panel for that meeting to double check "Linked Projects" list specifically contains it
  const summaries = [...doc.querySelectorAll('details.dl summary')];
  // The dropdown labels a meeting "AANA — 2027 Annual Meeting (Aug 10)", but the board's
  // summary prints the date as its own field ("... Abstracts due Aug 10"), so the trailing
  // "(Aug 10)" never appears there. Match on the meeting name alone.
  const meetingName = (meetingLabel.split(" — ")[1] || meetingLabel).replace(/\s*\([^)]*\)\s*$/, "").trim();
  const target = summaries.find(s => s.textContent.includes(meetingName));
  if (target) { target.click(); await wait(30); }
  const panelHTML = doc.getElementById("main").innerHTML;
  console.log("Details panel found for the meeting:", !!target);
  console.log("Panel's Linked Projects section shows the study:", panelHTML.includes(studyTitle));

  // --- Direction 2: link a DIFFERENT meeting from the side panel's "+ Link a project" sheet, confirm it shows on the study side ---
  const linkBtn = [...doc.querySelectorAll('[data-link-meeting]')][1] || doc.querySelectorAll('[data-link-meeting]')[0];
  const meeting2Id = linkBtn.dataset.linkMeeting;
  const meeting2 = window.state ? null : null; // (state not accessible from here; identify via DOM instead)
  linkBtn.click();
  await wait(50);
  const checkbox = doc.querySelector(`.link-study[data-sid="${card.dataset.study}"]`);
  console.log("Found study checkbox in side-panel Link Projects sheet:", !!checkbox);
  const wasChecked = checkbox.checked;
  if (!wasChecked) checkbox.checked = true;
  doc.getElementById("sheet-save").click();
  await wait(50);

  studiesBtn.click();
  await wait(50);
  card.click();
  await wait(50);
  const studyDetailHTML = doc.getElementById("main").innerHTML;
  console.log("Study detail now shows a 2nd linked deadline row after linking from the side panel:", (studyDetailHTML.match(/data-unlink-meeting/g) || []).length >= (wasChecked ? 1 : 2));

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
