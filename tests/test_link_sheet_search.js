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
function typeInto(el, value) { el.value = value; el.dispatchEvent(new window.Event("input")); }
const visibleRows = (doc, sel) => [...doc.querySelectorAll(sel)].filter(r => r.style.display !== "none");

(async () => {
  await wait(300);
  const doc = window.document;

  const settingsBtn = doc.querySelector('button[data-tab="settings"]');
  settingsBtn.click();
  await wait(50);
  const loadSampleBtn = [...doc.querySelectorAll('button')].find(b => b.textContent.includes("Load Sample Data"));
  if (loadSampleBtn) { loadSampleBtn.click(); await wait(50); }

  // ---------- Link Projects sheet (from a deadline) ----------
  // Reached in the UI from a deadline's side panel ([data-link-meeting]); called directly here so
  // the test doesn't depend on which board/panel happens to be on screen.
  const meetingId = window.eval("state.meetings[0].id");
  window.eval(`openLinkSheet(${JSON.stringify(meetingId)})`);
  await wait(80);

  const search = () => doc.getElementById("link-study-search");
  console.log("Link Projects sheet has a search box:", !!search());
  console.log("Link Projects sheet has a '+ New Project' button:", !!doc.getElementById("link-new-study"));
  const totalRows = doc.querySelectorAll("#link-study-list .link-row").length;
  console.log("All sample projects listed before searching:", totalRows > 1);

  // Tick a box first, then search — the selection must survive filtering.
  const firstBox = doc.querySelector(".link-study");
  firstBox.checked = true;
  const tickedId = firstBox.dataset.sid;

  typeInto(search(), "Scaffold");
  await wait(50);
  const shown = visibleRows(doc, "#link-study-list .link-row");
  console.log("Search narrows the project list:", shown.length === 1 && /Scaffold/i.test(shown[0].textContent));
  console.log("Rows hidden by search are still in the DOM (not unlinked):", doc.querySelectorAll("#link-study-list .link-row").length === totalRows);
  console.log("A box ticked before searching stays ticked while filtered:", doc.querySelector(`.link-study[data-sid="${tickedId}"]`).checked === true);

  // Tapping anywhere on the row (not just the small checkbox) must toggle it — this is how you
  // actually link a project after searching for it.
  const rowFor = (title) => [...doc.querySelectorAll("#link-study-list .link-row")].find(r => r.textContent.includes(title));
  const scaffoldRow = rowFor("Scaffold");
  console.log("Row carries a click handler making it tappable:", typeof scaffoldRow.onclick === "function");
  const scaffoldBox = scaffoldRow.querySelector(".link-study");
  const wasChecked = scaffoldBox.checked;
  scaffoldRow.querySelector("span").click(); // click the text, not the checkbox
  await wait(50);
  console.log("Clicking the project name toggles its checkbox:", scaffoldBox.checked === !wasChecked);
  scaffoldRow.querySelector("span").click();
  await wait(50);
  console.log("Clicking again toggles it back:", scaffoldBox.checked === wasChecked);

  // Clear button restores the full list
  const clearBtn = doc.getElementById("link-study-search-clear");
  console.log("Clear button appears once a query is typed:", clearBtn.style.display !== "none");
  clearBtn.click();
  await wait(50);
  console.log("Clearing search restores every row:", visibleRows(doc, "#link-study-list .link-row").length === totalRows);

  // No-match empty state
  typeInto(search(), "zzzznomatch");
  await wait(50);
  console.log("No-match state shown when nothing matches:", doc.getElementById("link-study-empty").style.display !== "none");
  console.log("No rows visible on a no-match search:", visibleRows(doc, "#link-study-list .link-row").length === 0);
  doc.getElementById("link-study-search-clear").click();
  await wait(50);

  // ---------- "+ New Project" round trip ----------
  // Tick a box, hop out to create a project, and confirm we come back with both it and the
  // previously-ticked box selected.
  const preTicked = doc.querySelector(".link-study");
  preTicked.checked = true;
  const preTickedId = preTicked.dataset.sid;

  doc.getElementById("link-new-study").onclick();
  await wait(450);
  console.log("Clicking '+ New Project' opens the study form:", !!doc.getElementById("f-title"));

  doc.getElementById("f-title").value = "Brand New Linked Project";
  doc.getElementById("f-pi").value = "Yanke";
  doc.getElementById("sheet-save").click();
  await wait(500);

  console.log("Returns to the Link Projects sheet after saving:", !!doc.getElementById("link-study-search"));
  const newRow = [...doc.querySelectorAll("#link-study-list .link-row")]
    .find(r => r.textContent.includes("Brand New Linked Project"));
  console.log("Newly created project appears in the list:", !!newRow);
  console.log("Newly created project comes back pre-checked:", !!newRow && newRow.querySelector(".link-study").checked === true);
  const preStill = doc.querySelector(`.link-study[data-sid="${preTickedId}"]`);
  console.log("Selection made before the detour is preserved:", !!preStill && preStill.checked === true);

  // Saving persists both links onto the meeting
  doc.getElementById("sheet-save").click();
  await wait(80);
  const linkedCount = window.eval(`(function(){
    var m = state.meetings.find(function(x){ return (x.studyIds||[]).length; });
    return m ? m.studyIds.length : 0;
  })()`);
  console.log("Saving links multiple projects to the deadline:", linkedCount >= 2);

  // ---------- Link Deadlines sheet (the reverse direction, from a study) ----------
  const studyId = window.eval("state.studies[0].id");
  window.eval(`openStudyLinkSheet(${JSON.stringify(studyId)})`);
  await wait(80);
  const mtgSearch = doc.getElementById("link-mtg-search");
  console.log("Link Deadlines sheet has a search box:", !!mtgSearch);
  const mtgTotal = doc.querySelectorAll("#link-mtg-list .link-row").length;
  const someSociety = window.eval("state.meetings[0].society");
  typeInto(mtgSearch, someSociety);
  await wait(50);
  const mtgShown = visibleRows(doc, "#link-mtg-list .link-row");
  console.log("Deadline search narrows by society:", mtgShown.length > 0 && mtgShown.every(r => r.textContent.toLowerCase().includes(someSociety.toLowerCase())));
  // Same tap-anywhere fix on the reverse sheet
  const mtgRow = mtgShown[0];
  const mtgBox = mtgRow.querySelector(".link-mtg");
  const mtgWas = mtgBox.checked;
  mtgRow.querySelector("span").click();
  await wait(50);
  console.log("Clicking a deadline row toggles its checkbox:", mtgBox.checked === !mtgWas);
  mtgRow.querySelector("span").click();
  await wait(50);
  doc.getElementById("link-mtg-search-clear").click();
  await wait(50);
  console.log("Clearing deadline search restores every row:", visibleRows(doc, "#link-mtg-list .link-row").length === mtgTotal);

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
