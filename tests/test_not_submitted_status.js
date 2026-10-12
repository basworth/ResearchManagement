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
  const card = doc.querySelector('.study-row');
  // The card heading shows the nickname when there is one; the deadline panel lists full titles.
  const studyTitle = window.eval(
    `(state.studies.find(s => s.id === ${JSON.stringify(card.getAttribute("data-study"))}) || {}).title`);
  card.click();
  await wait(50);

  const absSelect = doc.getElementById("link-existing-dl-abs");
  // Must pick a meeting with a real UPCOMING deadline. The dropdown also lists meetings whose
  // submission date hasn't been announced, and those are deliberately kept off the dashboard
  // board — linking one would leave nothing for the later board assertions to find.
  const upcoming = new Set(window.eval(`JSON.stringify(state.meetings
    .filter(m => (m.type||"abstract") !== "grant" && m.deadline && daysUntil(m.deadline) >= 0)
    .map(m => m.id))`) ? JSON.parse(window.eval(`JSON.stringify(state.meetings
    .filter(m => (m.type||"abstract") !== "grant" && m.deadline && daysUntil(m.deadline) >= 0)
    .map(m => m.id))`)) : []);
  const meetingOption = [...absSelect.options].find(o => o.value && upcoming.has(o.value));
  const meetingId = meetingOption.value;
  const meetingLabel = meetingOption.textContent; // e.g. "AANA — 2027 Annual Meeting (Aug 10)"
  const meetingName = meetingLabel.split(" — ")[1] ? meetingLabel.split(" — ")[1].split(" (")[0] : meetingLabel;
  absSelect.value = meetingId;
  absSelect.dispatchEvent(new window.Event("change"));
  await wait(50);

  const statusBtn = () => doc.querySelector(`[data-abs-link-status="${meetingId}"]`);
  console.log("Newly linked deadline defaults to Not Submitted:", statusBtn().textContent.trim() === "Not Submitted");

  // The status should surface right in the Dashboard's Abstract Deadlines dropdown for that
  // meeting, next to the linked project chip — no separate section on the dashboard.
  const dashBtn = doc.querySelector('button[data-tab="dashboard"]');
  dashBtn.click();
  await wait(50);
  console.log("Dashboard does NOT have a separate 'Needs Abstract Submission' section:", !doc.getElementById("main").innerHTML.includes("Needs Abstract Submission"));

  const findDeadlineDetails = () => [...doc.querySelectorAll('details.dl')].find(d => d.querySelector('summary').textContent.includes(meetingName));
  let target = findDeadlineDetails();
  console.log("Found the meeting's entry in the Dashboard's deadline board:", !!target);
  target.querySelector('summary').click();
  await wait(30);
  let panelHTML = target.querySelector('.dl-panel').innerHTML;
  console.log("Panel's Linked Projects shows a 'Not Submitted' badge next to the project:", panelHTML.includes("Not Submitted") && panelHTML.includes(studyTitle));

  // Cycle status: Not Submitted -> Submitted -> Accepted -> Rejected -> back to Not Submitted
  studiesBtn.click();
  await wait(50);
  card.click();
  await wait(50);
  statusBtn().click();
  await wait(50);
  console.log("Cycles to Submitted:", statusBtn().textContent.trim() === "Submitted");

  dashBtn.click();
  await wait(50);
  target = findDeadlineDetails();
  target.querySelector('summary').click();
  await wait(30);
  panelHTML = target.querySelector('.dl-panel').innerHTML;
  console.log("Dashboard dropdown badge updates to Submitted:", panelHTML.includes(">Submitted<") && panelHTML.includes(studyTitle));

  studiesBtn.click();
  await wait(50);
  card.click();
  await wait(50);
  statusBtn().click();
  await wait(50);
  console.log("Cycles to Accepted:", statusBtn().textContent.trim() === "Accepted");
  console.log("Accepted-format dropdown appears on the study page:", !!doc.querySelector(`[data-abs-accepted-format="${meetingId}"]`));

  statusBtn().click();
  await wait(50);
  console.log("Cycles to Rejected:", statusBtn().textContent.trim() === "Rejected");

  statusBtn().click();
  await wait(50);
  console.log("Wraps back around to Not Submitted:", statusBtn().textContent.trim() === "Not Submitted");

  dashBtn.click();
  await wait(50);
  target = findDeadlineDetails();
  target.querySelector('summary').click();
  await wait(30);
  panelHTML = target.querySelector('.dl-panel').innerHTML;
  console.log("Dashboard dropdown badge shows Not Submitted again after cycling back:", panelHTML.includes("Not Submitted") && panelHTML.includes(studyTitle));

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
