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
    win.supabase = { createClient: () => makeMockSupabase({ items: [] }) };
  }
});
const { window } = dom;

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
// Simulates a user typing into a search box: sets the value, fires input, matching how a real
// keystroke would trigger the app's oninput handler (React-less "input" event dispatch).
function typeInto(el, value) {
  el.value = value;
  el.dispatchEvent(new window.Event("input"));
}

(async () => {
  await wait(300);
  const doc = window.document;

  const settingsBtn = doc.querySelector('button[data-tab="settings"]');
  settingsBtn.click();
  await wait(50);
  const loadSampleBtn = [...doc.querySelectorAll('button')].find(b => b.textContent.includes("Load Sample Data"));
  if (loadSampleBtn) { loadSampleBtn.click(); await wait(50); }

  // --- Studies page ---
  const studiesBtn = doc.querySelector('button[data-tab="studies"]');
  studiesBtn.click();
  await wait(50);

  const studySearch = () => doc.getElementById("study-search");
  console.log("Studies search box renders:", !!studySearch());
  const allCount = doc.querySelectorAll('[data-study]').length;
  console.log("Studies list has sample data before searching:", allCount > 0);

  typeInto(studySearch(), "Scaffold");
  await wait(50);
  const scaffoldCards = [...doc.querySelectorAll('.study-row h3')].map(h => h.textContent);
  console.log("Searching 'Scaffold' matches by title/nickname:", scaffoldCards.length === 1 && scaffoldCards[0].includes("Cartilage Scaffold"));
  console.log("Search input keeps focus after typing (no re-render focus loss):", doc.activeElement === studySearch());
  console.log("Search input retains typed value:", studySearch().value === "Scaffold");

  // Search by IRB number
  typeInto(studySearch(), "ORA-24-1102");
  await wait(50);
  const irbCards = [...doc.querySelectorAll('.study-row h3')].map(h => h.textContent);
  console.log("Searching by IRB number matches the right study:", irbCards.length === 1 && irbCards[0].includes("ACL Reconstruction"));

  // No matches
  typeInto(studySearch(), "zzzznomatch");
  await wait(50);
  console.log("No-match search shows empty state referencing the query:", doc.getElementById("main").innerHTML.includes("zzzznomatch"));
  console.log("Search box still present after a no-match search (can still clear/edit):", !!studySearch());

  // Clear button
  const clearBtn = doc.getElementById("study-search-clear");
  console.log("Clear button present when there is a query:", !!clearBtn);
  clearBtn.click();
  await wait(50);
  console.log("Clearing search restores full list:", doc.querySelectorAll('[data-study]').length === allCount);
  console.log("Clear button hidden once query is empty:", !doc.getElementById("study-search-clear"));

  // Search composes with the Who/status filters rather than replacing them
  typeInto(studySearch(), "Yanke");
  await wait(50);
  const yankeCount = doc.querySelectorAll('[data-study]').length;
  console.log("Searching a PI name narrows results without erroring:", yankeCount > 0 && yankeCount <= allCount);

  // --- Worklist page ---
  typeInto(studySearch(), ""); // reset before switching tabs
  await wait(50);
  const worklistBtn = doc.querySelector('button[data-tab="worklist"]');
  worklistBtn.click();
  await wait(50);

  const wlSearch = () => doc.getElementById("worklist-search");
  console.log("Worklist search box renders:", !!wlSearch());
  const wlAllCount = doc.querySelectorAll('.wl tbody tr').length;

  typeInto(wlSearch(), "MPFL");
  await wait(50);
  const wlRows = [...doc.querySelectorAll('.wl tbody tr')].map(tr => tr.textContent);
  console.log("Worklist search filters rows by nickname:", wlRows.length === 1 && wlRows[0].includes("MPFL"));
  console.log("Worklist search input keeps focus after typing:", doc.activeElement === wlSearch());

  // Published study is excluded from the default Active worklist view even if it matches search
  typeInto(wlSearch(), "Osteochondral");
  await wait(50);
  console.log("Search respects Active/All toggle (Published study hidden under Active):", doc.querySelectorAll('.wl tbody tr').length === 0);
  const allSegBtn = [...doc.querySelectorAll('.seg button')].find(b => b.textContent === "All");
  allSegBtn.click();
  await wait(50);
  console.log("Switching to All + search shows the previously-hidden Published study:", doc.querySelectorAll('.wl tbody tr').length === 1);
  // Search value should survive the Active/All toggle re-render
  console.log("Search box value persists across Active/All toggle:", doc.getElementById("worklist-search").value === "Osteochondral");

  const wlClear = doc.getElementById("worklist-search-clear");
  wlClear.click();
  await wait(50);
  console.log("Clearing worklist search restores rows (now on All tab):", doc.querySelectorAll('.wl tbody tr').length >= wlAllCount);

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
