// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// A study page carries thirteen sections. Which START OPEN follows two tests, and a section has to
// pass both: the phase has to care about it, AND it has to hold something. An empty section open is
// a header, a blank space and an input box saying there's nothing here.
//
// Nothing is ever removed from the page — Adam was explicit that "hiding" meant collapsing.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();

// One study per phase, plus one carrying content in sections irrelevant to its phase.
const mk = (id, phase, design, extra) => ({ id, kind: "study", data: Object.assign({
  id, title: id, nickname: "", pi: "Adam Yanke", team: [], design, phase,
  priority: "Medium", irb: id, milestones: []
}, extra || {}), updated_at: now });

const mockItems = [
  mk("concept", "Concept", "Prospective (Consented)"),
  mk("initiation", "Initiation", "Prospective (Consented)"),
  mk("enrolling", "Enrolling", "Prospective (Consented)", { enrollTarget: 30, enrollCurrent: 12 }),
  mk("manuscript", "Manuscript", "Prospective (Consented)"),
  mk("revisions", "Revisions Required", "Prospective (Consented)"),
  mk("published", "Published", "Prospective (Consented)"),
  mk("hold", "On Hold", "Prospective (Consented)"),
  mk("extraction", "Data Extraction", "Retrospective (Non-Consented)"),
  mk("experiments", "Experiments", "Basic Science / Exempt"),
  // Published study that still carries enrolment numbers and meeting notes — both irrelevant to
  // Published, so they must be present-but-collapsed, never gone.
  mk("legacy", "Published", "Prospective (Consented)", {
    enrollTarget: 50, enrollCurrent: 50,
    meetingNotes: [{ id: "m1", label: "Kickoff", link: "https://x", date: "2026-01-01" }],
    noteEntries: [{ id: "n1", text: "Something worth keeping", date: "2026-01-01", archivedOn: "" }]
  }),
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} }, updated_at: now }
];

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items: mockItems }) };
  }
});
const { window } = dom, doc = window.document;
const wait = ms => new Promise(r => setTimeout(r, ms));

async function open(id) { window.eval(`tab = "studies"; openStudy("${id}"); render();`); await wait(110); }
const isOpen = (id) => { const b = doc.querySelector(`[data-sec-body="${id}"]`); return !!b && b.style.display !== "none"; };
const present = (id) => !!doc.querySelector(`[data-sec-body="${id}"]`);
// Always rendered regardless of phase or content.
// "docs" and "revisionDocs" are gone: documents now live in workingDocs, and revision documents
// inside the manuscript section. See test_doc_slots.js for where everything went.
const ALWAYS = ["notes","enrollment","authors","workingDocs","meetingNotes","milestones","abstracts","deadlines"];

(async () => {
  await wait(430);
  window.eval('upsertProfile("Adam Yanke"); syncOnline = true;');
  await wait(60);

  console.log("\n-- Nothing is ever removed from the page --");
  for (const id of ["concept", "initiation", "enrolling", "manuscript", "published"]) {
    await open(id);
    const missing = ALWAYS.filter(sec => !present(sec));
    check(`Every section is present on a ${id} study`, missing.length === 0, missing);
  }

  console.log("\n-- The two conditional sections behave as intended --");
  await open("concept");
  // Grant became an always-present section in the 2026-09-15 restructure — like every other
  // section it collapses rather than disappearing, so "not funded" shows an empty section
  // rather than no section. Asserting its presence is now the correct expectation.
  check("The grant section is always present, funded or not", present("grant"));
  check("A study with no initiation progress shows no checklist", !present("initiation"));
  window.eval(`(function(){ var s = studyById("published"); s.initiationProgress = { coverage: { status: "Passed", submitted: "2026-01-02", passed: "2026-02-01" } }; })();`);
  await open("concept");
  await open("published");
  check("Recorded initiation progress KEEPS the checklist after the phase moves on", present("initiation"));
  check("...collapsed, since Published isn't about starting up", !isOpen("initiation"));
  check("...and its dates are still there", doc.getElementById("main").innerHTML.includes("2026-02-01")
    || doc.getElementById("main").innerHTML.includes("Feb"));

  console.log("\n-- N/A stages drop off the study page but keep their record --");
  window.eval(`(function(){
    var s = studyById("initiation");
    s.initiationProgress = { feasibility: { status: "N/A" }, irb: { status: "Submitted", submitted: "2026-03-04" } };
  })();`);
  await open("concept");
  await open("initiation");
  const initHTML = doc.querySelector('[data-sec-body="initiation"]').innerHTML;
  check("The N/A stage is not listed", !initHTML.includes("Feasibility"), null);
  check("A live stage still is", initHTML.includes("IRB approval"));
  check("...and says how many are hidden", /not applicable and hidden/.test(initHTML), null);
  check("The N/A record itself is intact",
    window.eval('studyById("initiation").initiationProgress.feasibility.status') === "N/A");
  window.eval('openInitiationSheet("initiation")');
  await wait(120);
  check("The edit sheet still offers the N/A stage, so it can be switched back",
    !!doc.getElementById("f-st-feasibility"));
  check("...showing it as N/A", doc.getElementById("f-st-feasibility").value === "N/A");
  doc.getElementById("sheet-cancel").click();
  await wait(400);

  console.log("\n-- Initiation opens the initiation checklist --");
  await open("initiation");
  check("Initiation checklist open — it has recorded stages", isOpen("initiation"));
  // Phase-relevant but empty, so collapsed: there is nothing to read in them.
  check("Notes collapsed, because there are none", !isOpen("notes"));
  check("Working documents collapsed, because there are none", !isOpen("workingDocs"));
  check("Manuscript submission collapsed", !isOpen("manuscript"));
  check("Enrolment collapsed", !isOpen("enrollment"));

  console.log("\n-- Enrolling brings enrolment forward --");
  await open("enrolling");
  check("Enrolment open", isOpen("enrollment"));
  check("Initiation checklist now collapsed", !isOpen("initiation"));
  check("Manuscript submission still collapsed", !isOpen("manuscript"));

  console.log("\n-- Manuscript brings documents and authors forward --");
  await open("manuscript");
  check("Working documents open", isOpen("workingDocs"));
  check("Proposed authors open", isOpen("authors"));
  check("Abstract submissions open", isOpen("abstracts"));
  check("Enrolment collapsed", !isOpen("enrollment"));
  check("Initiation collapsed", !isOpen("initiation"));

  console.log("\n-- Revisions brings the manuscript section forward --");
  await open("revisions");
  // The reviewer comments, the decision and the revision dates are all in Manuscript Submission
  // now, so that is the one section a study in revisions should land on.
  check("Manuscript submission open", isOpen("manuscript"));
  check("Working documents collapsed, because there are none", !isOpen("workingDocs"));
  check("Enrolment collapsed", !isOpen("enrollment"));

  console.log("\n-- Published is a reading view --");
  await open("published");
  check("Manuscript submission open", isOpen("manuscript"));
  check("Abstracts collapsed, because there are none", !isOpen("abstracts"));
  check("Tasks section still on the page", doc.getElementById("main").innerHTML.includes(">Tasks"));

  console.log("\n-- Each design's own middle phase works --");
  await open("extraction");
  check("Data Extraction opens working documents", isOpen("workingDocs"));
  check("...and collapses enrolment, which retrospectives don't have", !isOpen("enrollment"));
  await open("experiments");
  check("Experiments opens working documents", isOpen("workingDocs"));
  check("...and collapses the manuscript section", !isOpen("manuscript"));

  console.log("\n-- On Hold is deliberately quiet --");
  await open("hold");
  check("Notes open", isOpen("notes"));
  check("Manuscript submission collapsed", !isOpen("manuscript"));
  check("Enrolment collapsed", !isOpen("enrollment"));
  check("Working documents collapsed", !isOpen("workingDocs"));

  console.log("\n-- Content in an irrelevant section is kept and signposted --");
  await open("legacy");
  check("Enrolment section still present on a Published study", present("enrollment"));
  check("...collapsed, because Published isn't about enrolling", !isOpen("enrollment"));
  const hdr = doc.getElementById("main").innerHTML;
  check("...but its numbers are advertised on the header", hdr.includes("50/50"), (hdr.match(/50\/50/) || [])[0]);
  check("Meeting notes kept too", present("meetingNotes"));
  check("...with a count on the collapsed header", /Meeting Notes<span[^>]*>1</.test(hdr) || hdr.includes(">1<"));
  check("The note itself is still in the DOM, not discarded", hdr.includes("Something worth keeping"));

  console.log("\n-- Manual toggles survive a re-render --");
  await open("manuscript");
  check("Enrolment starts collapsed", !isOpen("enrollment"));
  doc.querySelector('[data-sec-toggle="enrollment"]').click();
  await wait(60);
  check("Opening it works", isOpen("enrollment"));
  window.eval("render();");
  await wait(80);
  check("...and it stays open after a re-render", isOpen("enrollment"));

  console.log("\n-- Changing phase re-decides on next open --");
  window.eval(`(function(){ var s = studyById("manuscript"); s.phase = "Enrolling"; })();`);
  await open("concept");     // leave, so section state is recomputed
  await open("manuscript");
  check("Now-Enrolling study opens enrolment", isOpen("enrollment"));
  check("...and collapses the manuscript section", !isOpen("manuscript"));

  console.log("\n-- The phase map covers every phase in every track --");
  const uncovered = JSON.parse(window.eval(`JSON.stringify(
    PHASES.filter(p => !PHASE_SECTIONS[p])
  )`));
  check("No phase falls through to the default", uncovered.length === 0, uncovered);

  console.log("\n-- Empty sections start collapsed, full ones don't --");
  {
    // Two studies in the SAME phase, one empty and one not, so the only variable is content.
    window.eval(`
      state.studies.push({ id: "full", title: "full", nickname: "", pi: "Adam Yanke", team: [],
        design: "Prospective (Consented)", phase: "Manuscript", priority: "Medium", irb: "full",
        milestones: [{ id: "ms1", label: "Data locked", date: "2026-02-01" }],
        noteEntries: [{ id: "n9", text: "Worth keeping", date: "2026-02-01", archivedOn: "" }],
        abstracts: [{ id: "a9", meeting: "AAOS 2027", date: "2026-11-01", status: "Submitted" }],
        team: ["Adam Yanke"], docs: [], meetingNotes: [], authors: [] });
      // Has SOMETHING (one working document), so the "everything empty" fallback doesn't fire and
      // we're testing the rule itself rather than the guard.
      state.studies.push({ id: "sparse", title: "sparse", nickname: "", pi: "Adam Yanke", team: [],
        design: "Prospective (Consented)", phase: "Manuscript", priority: "Medium", irb: "sparse",
        workingManuscriptLink: "https://docs.example.com/ms",
        milestones: [], noteEntries: [], abstracts: [], docs: [], meetingNotes: [], authors: [] });
      state.studies.push({ id: "bare", title: "bare", nickname: "", pi: "Adam Yanke", team: [],
        design: "Prospective (Consented)", phase: "Manuscript", priority: "Medium", irb: "bare",
        milestones: [], noteEntries: [], abstracts: [], docs: [], meetingNotes: [], authors: [] });
      migrate();
    `);
    await open("full");
    check("A study WITH notes opens them", isOpen("notes"));
    check("...and its abstracts", isOpen("abstracts"));
    await open("sparse");
    check("Its working documents open, because it has one", isOpen("workingDocs"));
    check("...but its empty notes stay shut", !isOpen("notes"));
    check("...and its empty abstracts stay shut", !isOpen("abstracts"));
    check("Both are still on the page, one tap away", present("notes") && present("abstracts"));
  }

  console.log("\n-- A brand-new study doesn't look broken --");
  {
    // Everything empty: collapsing the lot would give a wall of shut headers and nowhere obvious
    // to start typing, so the phase's own sections open as a fallback.
    await open("bare");
    const anyOpen = ALWAYS.some(id => isOpen(id)) || isOpen("tasks") || isOpen("manuscript");
    check("Something is open to type into", anyOpen);
    dom.window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
