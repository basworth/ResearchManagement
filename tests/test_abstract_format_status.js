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

  // On a fresh profile the app opens a "Welcome — what's your name?" sheet at boot. Without
  // clearing it, the later "tapping the status badge opens no sheet" assertion sees THAT
  // sheet and reports a failure that has nothing to do with the badge. Set a name, then wait
  // out closeSheet()'s 320ms removal timeout so #sheet is genuinely gone.
  window.eval('upsertProfile("Adam Yanke")');
  const welcomeCancel = doc.getElementById("sheet-cancel");
  if (welcomeCancel) welcomeCancel.click();
  await wait(400);

  const settingsBtn = doc.querySelector('button[data-tab="settings"]');
  settingsBtn.click();
  await wait(50);
  const loadSampleBtn = [...doc.querySelectorAll('button')].find(b => b.textContent.includes("Load Sample Data"));
  if (loadSampleBtn) { loadSampleBtn.click(); await wait(50); }

  const studiesBtn = doc.querySelector('button[data-tab="studies"]');
  studiesBtn.click();
  await wait(50);
  const card = doc.querySelector('.study-row');
  card.click();
  await wait(50);

  // Link an abstract deadline first
  const absSelect = doc.getElementById("link-existing-dl-abs");
  const meetingOption = [...absSelect.options].find(o => o.value);
  const meetingId = meetingOption.value;
  absSelect.value = meetingId;
  absSelect.dispatchEvent(new window.Event("change"));
  await wait(50);

  console.log("Format dropdown (poster/podium) rendered for linked deadline:", !!doc.querySelector(`[data-abs-format="${meetingId}"]`));
  const statusBtn = doc.querySelector(`[data-abs-link-status="${meetingId}"]`);
  console.log("Status badge present, defaults to Not Submitted:", statusBtn && statusBtn.textContent.trim() === "Not Submitted");
  console.log("Accepted-format dropdown NOT shown before acceptance:", !doc.querySelector(`[data-abs-accepted-format="${meetingId}"]`));

  // Clicking the format/status controls should NOT open the meeting edit sheet
  const sheetBeforeTap = !!doc.getElementById("sheet");
  statusBtn.click();
  await wait(50);
  console.log("No sheet was hanging around before the tap:", !sheetBeforeTap);
  console.log("No sheet opened just from tapping the status badge:", !doc.getElementById("sheet"));
  console.log("Status advanced to Submitted after one tap:", doc.querySelector(`[data-abs-link-status="${meetingId}"]`).textContent.trim() === "Submitted");

  // Set the submission format
  const formatSelect = doc.getElementById ? doc.querySelector(`[data-abs-format="${meetingId}"]`) : null;
  formatSelect.value = "Poster";
  formatSelect.dispatchEvent(new window.Event("change"));
  await wait(50);
  console.log("Format persists after re-render:", doc.querySelector(`[data-abs-format="${meetingId}"]`).value === "Poster");

  // Cycle status again: Submitted -> Accepted
  doc.querySelector(`[data-abs-link-status="${meetingId}"]`).click();
  await wait(50);
  console.log("Status advanced to Accepted after second tap:", doc.querySelector(`[data-abs-link-status="${meetingId}"]`).textContent.trim() === "Accepted");
  console.log("Accepted-format dropdown appears once status is Accepted:", !!doc.querySelector(`[data-abs-accepted-format="${meetingId}"]`));

  const acceptedSelect = doc.querySelector(`[data-abs-accepted-format="${meetingId}"]`);
  acceptedSelect.value = "E-Poster";
  acceptedSelect.dispatchEvent(new window.Event("change"));
  await wait(50);
  console.log("Accepted format persists after re-render:", doc.querySelector(`[data-abs-accepted-format="${meetingId}"]`).value === "E-Poster");
  console.log("Submitted format also still persisted alongside accepted format:", doc.querySelector(`[data-abs-format="${meetingId}"]`).value === "Poster");

  // Cycle to Rejected: the accepted-format select should disappear again (though the saved value is preserved internally)
  doc.querySelector(`[data-abs-link-status="${meetingId}"]`).click();
  await wait(50);
  console.log("Accepted-format dropdown hides again once status leaves Accepted:", !doc.querySelector(`[data-abs-accepted-format="${meetingId}"]`));
  console.log("Status advanced to Rejected after third tap:", doc.querySelector(`[data-abs-link-status="${meetingId}"]`).textContent.trim() === "Rejected");

  // One more tap should wrap back around to Not Submitted
  doc.querySelector(`[data-abs-link-status="${meetingId}"]`).click();
  await wait(50);
  console.log("Status wraps back around to Not Submitted after fourth tap:", doc.querySelector(`[data-abs-link-status="${meetingId}"]`).textContent.trim() === "Not Submitted");

  // Leave and reopen the study — confirm everything survived a fresh render
  doc.getElementById("back-btn").click();
  await wait(50);
  card.click();
  await wait(50);
  console.log("Format still Poster after leaving and reopening the study:", doc.querySelector(`[data-abs-format="${meetingId}"]`).value === "Poster");

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
