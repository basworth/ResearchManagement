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

  // --- Path A: link an ABSTRACT deadline from the STUDY side (dropdown), confirm task appears ---
  const studiesBtn = doc.querySelector('button[data-tab="studies"]');
  studiesBtn.click();
  await wait(50);
  const card = doc.querySelector('.study-row');
  card.click();
  await wait(50);
  const studyId = card.dataset.study;
  console.log("Opened study id:", studyId);

  const linkSelect = doc.getElementById("link-existing-dl-abs");
  console.log("link-existing-dl-abs present:", !!linkSelect);
  const meetingOption = [...linkSelect.options].find(o => o.value);
  console.log("Found a linkable abstract meeting option:", !!meetingOption);
  const meetingId = meetingOption.value;
  linkSelect.value = meetingId;
  linkSelect.dispatchEvent(new window.Event("change"));
  await wait(50);

  const tasksBtn = doc.querySelector('button[data-tab="tasks"]');
  tasksBtn.click();
  await wait(50);
  // Tasks now opens on "Mine"; switch to "Open" so every seeded task is in view here.
  [...doc.querySelectorAll(".seg button")].find(function(b){return b.textContent.trim()==="Open"}).click();
  await wait(50);
  let bodyText = doc.getElementById("main").innerHTML;
  console.log("A linked submission task appears in Tasks list:", bodyText.includes("Submit abstract:") || bodyText.includes("Submit grant application:"));
  console.log("Task row shows a jump-to-meeting badge:", bodyText.includes("data-goto-meeting"));

  // Unlink from study side and confirm task disappears
  studiesBtn.click();
  await wait(50);
  card.click();
  await wait(50);
  const unlinkBtn = doc.querySelector(`[data-unlink-meeting="${meetingId}"]`);
  console.log("Found unlink button:", !!unlinkBtn);
  if (unlinkBtn) unlinkBtn.click();
  await wait(50);
  tasksBtn.click();
  await wait(50);
  [...doc.querySelectorAll(".seg button")].find(function(b){return b.textContent.trim()==="Open"}).click();
  await wait(50);
  bodyText = doc.getElementById("main").innerHTML;
  console.log("Task removed after unlinking from study side:", !bodyText.includes("Submit abstract:") && !bodyText.includes("Submit grant application:"));

  // --- Path B: link from the MEETING side (bulk sheet openLinkSheet), confirm task appears ---
  // Re-link via toggleStudyLink equivalent path: call openLinkSheet directly
  window.openLinkSheet(meetingId);
  await wait(50);
  const checkbox = doc.querySelector(`.link-study[data-sid="${studyId}"]`);
  console.log("Found study checkbox in Link Projects sheet:", !!checkbox);
  checkbox.checked = true;
  const saveBtn = doc.getElementById("sheet-save");
  saveBtn.click();
  await wait(50);

  tasksBtn.click();
  await wait(50);
  [...doc.querySelectorAll(".seg button")].find(function(b){return b.textContent.trim()==="Open"}).click();
  await wait(50);
  bodyText = doc.getElementById("main").innerHTML;
  console.log("Task created after linking from MEETING side (bulk sheet):", bodyText.includes("Submit abstract:") || bodyText.includes("Submit grant application:"));

  // Uncheck via same sheet to confirm removal syncs back too
  window.openLinkSheet(meetingId);
  await wait(50);
  const checkbox2 = doc.querySelector(`.link-study[data-sid="${studyId}"]`);
  checkbox2.checked = false;
  doc.getElementById("sheet-save").click();
  await wait(50);
  tasksBtn.click();
  await wait(50);
  [...doc.querySelectorAll(".seg button")].find(function(b){return b.textContent.trim()==="Open"}).click();
  await wait(50);
  bodyText = doc.getElementById("main").innerHTML;
  console.log("Task removed after unlinking from MEETING side (bulk sheet):", !bodyText.includes("Submit abstract:") && !bodyText.includes("Submit grant application:"));

  // --- Path C: link a GRANT deadline from the study side, confirm it shows under Grant Deadlines only ---
  studiesBtn.click();
  await wait(50);
  card.click();
  await wait(50);
  const grantSelect = doc.getElementById("link-existing-dl-grant");
  console.log("link-existing-dl-grant present:", !!grantSelect);
  const grantOption = [...grantSelect.options].find(o => o.value);
  console.log("Found a linkable grant option:", !!grantOption);
  if (grantOption) {
    grantSelect.value = grantOption.value;
    grantSelect.dispatchEvent(new window.Event("change"));
    await wait(50);
    const detailHTML = doc.getElementById("main").innerHTML;
    console.log("Grant deadline appears under Grant Deadlines section:", detailHTML.includes("Grant Deadlines"));
  }

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
