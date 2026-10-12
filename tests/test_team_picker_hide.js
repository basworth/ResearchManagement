// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

// Seed the mock backend with legacy-format records: free-text `team`, short-form PI names, and
// the same person spelled several ways — exactly what's in the live database today.
const now = new Date().toISOString();
const mockItems = [
  { id: "s-legacy-1", kind: "study", data: { id: "s-legacy-1", title: "Legacy Team String Study", nickname: "Legacy A", pi: "Yanke", team: "Zach O, TJ T", design: "Prospective (Consented)", phase: "Concept", priority: "Medium", irb: "ORA-99-0001", milestones: [] }, updated_at: now },
  { id: "s-legacy-2", kind: "study", data: { id: "s-legacy-2", title: "Second Legacy Study", nickname: "Legacy B", pi: "Cat", team: "Zachary Oppenheim BS", design: "Retrospective (Non-Consented)", phase: "Analysis", priority: "Low", irb: "ORA-99-0002", milestones: [] }, updated_at: now },
  { id: "m-keep", kind: "meeting", data: { id: "m-keep", key: "AANA|Keep Me", society: "AANA", name: "Keep Me", type: "abstract", deadline: "2027-06-01", studyIds: [], funded: [], hidden: false }, updated_at: now },
  { id: "m-hide", kind: "meeting", data: { id: "m-hide", key: "AAOS|Skip Me", society: "AAOS", name: "Skip Me", type: "abstract", deadline: "2027-06-02", studyIds: [], funded: [], hidden: false }, updated_at: now },
  { id: "m-grant", kind: "meeting", data: { id: "m-grant", key: "OREF|Skip This Grant", society: "OREF", name: "Skip This Grant", type: "grant", deadline: "2027-07-01", studyIds: [], funded: [], hidden: false }, updated_at: now }
];

const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items: mockItems }) };
  }
});
const { window } = dom;

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function typeInto(el, v) { el.value = v; el.dispatchEvent(new window.Event("input")); }
const visible = (doc, sel) => [...doc.querySelectorAll(sel)].filter(r => r.style.display !== "none");

(async () => {
  await wait(300);
  const doc = window.document;

  // ---------- Name canonicalization + team array migration ----------
  console.log("Alias maps short PI name to canonical:", window.eval('canonName("Yanke")') === "Adam Yanke");
  console.log("Alias maps credential-suffixed name to canonical:", window.eval('canonName("Zachary Oppenheim BS")') === "Zachary Oppenheim");
  console.log("All three Zach variants collapse to one name:", window.eval('[canonName("Zach"), canonName("Zach O"), canonName("Zachary Oppenheim BS")].every(function(x){return x==="Zachary Oppenheim"})') === true);
  console.log("Unknown names pass through untouched:", window.eval('canonName("Navya")') === "Navya");

  const team1 = window.eval('JSON.stringify(state.studies.find(function(s){return s.id==="s-legacy-1"}).team)');
  console.log("Free-text team migrated to a canonical array:", team1 === '["Zachary Oppenheim","Thomas Turinske"]', team1);

  const roster = window.eval("JSON.stringify(state.roster)");
  console.log("Roster auto-derived from PI + team across studies:", /Adam Yanke/.test(roster) && /Catherine Yuh/.test(roster) && /Zachary Oppenheim/.test(roster) && /Thomas Turinske/.test(roster));
  console.log("Roster holds one entry per person, not per spelling:", (roster.match(/Zachary Oppenheim/g) || []).length === 1);

  // The whole point: two studies that spelled Zach differently both belong to one person now.
  const zachStudies = window.eval('state.studies.filter(function(s){return studyInvolvesPerson(s, "Zachary Oppenheim")}).length');
  console.log("Both differently-spelled studies link to the one canonical person:", zachStudies === 2);
  console.log("Old short-form PI name still resolves to the right person:", window.eval('studyInvolvesPerson(state.studies.find(function(s){return s.id==="s-legacy-1"}), "Adam Yanke")') === true);
  console.log("Someone uninvolved does NOT match:", window.eval('studyInvolvesPerson(state.studies.find(function(s){return s.id==="s-legacy-1"}), "Navya")') === false);

  // Sign in as an admin: the Who picker is admin-only now, and this test needs to see every study.
  window.eval('upsertProfile("Adam Yanke")');
  // ---------- Team picker in the study form ----------
  const studiesBtn = doc.querySelector('button[data-tab="studies"]');
  studiesBtn.click();
  await wait(60);
  const personSel = doc.getElementById("person-filter");
  personSel.value = "all";
  personSel.dispatchEvent(new window.Event("change"));
  await wait(60);
  doc.querySelector('[data-study="s-legacy-1"]').click();
  await wait(60);
  console.log("Study detail renders the team array as a readable list:", doc.getElementById("main").innerHTML.includes("Zachary Oppenheim, Thomas Turinske"));

  doc.getElementById("edit-study-btn").click();
  await wait(80);
  console.log("Team is now a checkbox picker, not a free-text box:", !!doc.getElementById("f-team-list") && !doc.getElementById("f-team"));
  const checkedNames = [...doc.querySelectorAll(".f-team-pick")].filter(c => c.checked).map(c => c.dataset.name);
  console.log("Existing team members come back pre-ticked:", checkedNames.includes("Zachary Oppenheim") && checkedNames.includes("Thomas Turinske"));

  const teamSearch = doc.getElementById("f-team-search");
  typeInto(teamSearch, "turin");
  await wait(50);
  const shownRows = visible(doc, "#f-team-list .team-row");
  console.log("Team picker search narrows the people list:", shownRows.length === 1 && shownRows[0].textContent.includes("Thomas Turinske"));
  console.log("Ticked people stay ticked while the list is filtered:", doc.querySelector('.f-team-pick[data-name="Zachary Oppenheim"]').checked === true);
  doc.getElementById("f-team-search-clear").click();
  await wait(50);

  // Add someone brand new
  doc.getElementById("f-team-new").value = "Brand New Person";
  doc.getElementById("f-team-add").click();
  await wait(60);
  const newBox = doc.querySelector('.f-team-pick[data-name="Brand New Person"]');
  console.log("Adding an unlisted person appends them, ticked:", !!newBox && newBox.checked === true);
  console.log("Newly added person joins the shared roster:", window.eval('state.roster.indexOf("Brand New Person") >= 0'));
  console.log("Prior ticks survive adding someone new:", doc.querySelector('.f-team-pick[data-name="Thomas Turinske"]').checked === true);

  // Untick one, save, confirm it persists as an array
  doc.querySelector('.f-team-pick[data-name="Thomas Turinske"]').checked = false;
  doc.getElementById("sheet-save").click();
  await wait(80);
  // Order follows the picker's alphabetical row order, so compare as a set.
  const savedTeam = JSON.parse(window.eval('JSON.stringify(state.studies.find(function(s){return s.id==="s-legacy-1"}).team)'));
  console.log("Saved team is an array reflecting the ticks:",
    savedTeam.length === 2 && savedTeam.includes("Zachary Oppenheim") && savedTeam.includes("Brand New Person"), JSON.stringify(savedTeam));
  console.log("Unticked person no longer matches the study:", window.eval('studyInvolvesPerson(state.studies.find(function(s){return s.id==="s-legacy-1"}), "Thomas Turinske")') === false);
  console.log("Newly added person now matches the study:", window.eval('studyInvolvesPerson(state.studies.find(function(s){return s.id==="s-legacy-1"}), "Brand New Person")') === true);

  // ---------- Hiding a deadline ----------
  const dashBtn = doc.querySelector('button[data-tab="dashboard"]');
  dashBtn.click();
  await wait(60);
  let dash = doc.getElementById("main").innerHTML;
  console.log("Both abstract deadlines on the board before hiding:", dash.includes("Keep Me") && dash.includes("Skip Me"));
  console.log("Grant deadline on the board before hiding:", dash.includes("Skip This Grant"));

  // --- Inline "Hide" button, right on the deadline row next to Link a project / Edit ---
  const hideBtnFor = (id) => [...doc.querySelectorAll(`[data-hide-meeting="${id}"]`)][0];
  console.log("Deadline row has an inline Hide button beside Link/Edit:", !!hideBtnFor("m-keep"));
  const rowBtnLabels = [...doc.querySelectorAll('[data-link-meeting="m-keep"], [data-edit-meeting="m-keep"], [data-hide-meeting="m-keep"]')].map(b => b.textContent.trim());
  console.log("Hide sits alongside the other row actions:", rowBtnLabels.some(t => /Link a project/.test(t)) && rowBtnLabels.includes("Edit") && rowBtnLabels.includes("Hide"));

  hideBtnFor("m-keep").click();
  await wait(80);
  console.log("Inline Hide removes the deadline from the board:", !doc.getElementById("main").innerHTML.includes("Keep Me"));
  console.log("Inline Hide sets the flag rather than deleting:", window.eval('state.meetings.find(function(m){return m.id==="m-keep"}).hidden') === true);

  // Bring it back from Settings, where hidden ones still show
  doc.querySelector('button[data-tab="settings"]').click();
  await wait(60);
  const settingsUnhide = doc.querySelector('[data-meeting-hide="m-keep"]');
  console.log("Settings row offers an Unhide button:", !!settingsUnhide && settingsUnhide.textContent.trim() === "Unhide");
  settingsUnhide.click();
  await wait(80);
  console.log("Unhiding from Settings clears the flag:", window.eval('state.meetings.find(function(m){return m.id==="m-keep"}).hidden') === false);
  dashBtn.click();
  await wait(60);
  console.log("Unhidden deadline is back on the board:", doc.getElementById("main").innerHTML.includes("Keep Me"));

  // Hide the abstract via the deadline form's "Not submitting" checkbox
  window.eval('openMeetingForm(state.meetings.find(function(m){return m.id==="m-hide"}))');
  await wait(80);
  const hideBox = doc.getElementById("f-mhidden");
  console.log("Deadline form has a 'Not submitting' checkbox:", !!hideBox);
  hideBox.checked = true;
  doc.getElementById("sheet-save").click();
  await wait(80);

  // Same for the grant, to confirm it works for both types
  window.eval('openMeetingForm(state.meetings.find(function(m){return m.id==="m-grant"}))');
  await wait(80);
  doc.getElementById("f-mhidden").checked = true;
  doc.getElementById("sheet-save").click();
  await wait(80);

  dashBtn.click();
  await wait(60);
  dash = doc.getElementById("main").innerHTML;
  console.log("Hidden abstract drops off the dashboard:", !dash.includes("Skip Me"));
  console.log("Hidden grant drops off the dashboard:", !dash.includes("Skip This Grant"));
  console.log("Un-hidden deadline still shows:", dash.includes("Keep Me"));
  console.log("Hidden flag persisted on the record:", window.eval('state.meetings.find(function(m){return m.id==="m-hide"}).hidden') === true);
  console.log("Hidden deadline is NOT deleted, just hidden:", window.eval('!!state.meetings.find(function(m){return m.id==="m-hide"})') === true);

  // Settings still lists it, flagged, so it can be brought back
  doc.querySelector('button[data-tab="settings"]').click();
  await wait(60);
  const settings = doc.getElementById("main").innerHTML;
  console.log("Settings still lists the hidden deadline with a 'hidden' flag:", settings.includes("Skip Me") && settings.includes("hidden"));

  // Un-hide it again
  window.eval('openMeetingForm(state.meetings.find(function(m){return m.id==="m-hide"}))');
  await wait(80);
  console.log("Re-opening the form shows the box already ticked:", doc.getElementById("f-mhidden").checked === true);
  doc.getElementById("f-mhidden").checked = false;
  doc.getElementById("sheet-save").click();
  await wait(80);
  dashBtn.click();
  await wait(60);
  console.log("Un-hiding brings it back to the dashboard:", doc.getElementById("main").innerHTML.includes("Skip Me"));

  // ---------- Navigation defaults ----------
  const tasksBtn = doc.querySelector('button[data-tab="tasks"]');
  tasksBtn.click();
  await wait(60);
  const activeSeg = [...doc.querySelectorAll(".seg button")].find(b => b.classList.contains("active"));
  console.log("Tasks tab opens on the 'Mine' filter:", !!activeSeg && activeSeg.textContent.trim() === "Mine");

  // Switch to another filter, leave, come back -> back to Mine
  const openSeg = [...doc.querySelectorAll(".seg button")].find(b => b.textContent.trim() === "Open");
  openSeg.click();
  await wait(60);
  dashBtn.click();
  await wait(60);
  tasksBtn.click();
  await wait(60);
  const activeAgain = [...doc.querySelectorAll(".seg button")].find(b => b.classList.contains("active"));
  console.log("Returning to Tasks resets to 'Mine':", !!activeAgain && activeAgain.textContent.trim() === "Mine");

  // Studies tab from inside a project returns to the full list
  studiesBtn.click();
  await wait(60);
  doc.querySelector('[data-study]').click();
  await wait(60);
  console.log("Opened a study detail view:", doc.getElementById("page-title").textContent === "Study");
  studiesBtn.click();
  await wait(60);
  console.log("Tapping Studies from inside a project returns to the list:", doc.getElementById("page-title").textContent === "Studies" && doc.querySelectorAll("[data-study]").length > 0);

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
