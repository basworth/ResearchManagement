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
function bodyDisplay(doc, id) {
  const el = doc.querySelector(`[data-sec-body="${id}"]`);
  return el ? el.style.display : "MISSING";
}

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

  // s1 (first card) has milestones + abstracts in the seed data, but no grant/enrollment-target set
  // by default — a good mixed case for auto expand/collapse.
  const card = doc.querySelector('.study-row');
  card.click();
  await wait(50);

  console.log("Enrollment section present (always shown):", !!doc.querySelector('[data-sec-toggle="enrollment"]'));
  // Sections are never removed now — an irrelevant or empty one collapses instead, so that
  // nothing a study holds can disappear from view. The grant section is present but shut.
  console.log("Grant section present but collapsed when grant.enabled is false:",
    !!doc.querySelector('[data-sec-toggle="grant"]') && bodyDisplay(doc, "grant") === "none");
  // A section opens when its phase says it matters AND it has something in it: an empty section
  // auto-collapses whatever the phase says (Adam's request, Oct 2026).
  const phaseOf = () => window.eval("studyById(detailStudyId).phase");
  const expectOpen = (sec) => window.eval(
    `sectionOpenForPhase(${JSON.stringify(sec)}, ${JSON.stringify(phaseOf())}) && !!studySectionState[${JSON.stringify(sec)}]`);
  const agrees = (sec) => (bodyDisplay(doc, sec) === "") === expectOpen(sec);
  console.log("Milestones open/closed matches its phase:", agrees("milestones"));
  console.log("Working Documents matches its phase:", agrees("workingDocs"));
  console.log("Meeting Notes matches its phase:", agrees("meetingNotes"));
  console.log("Grant Deadlines matches its phase:", agrees("deadlines"));
  console.log("Tasks section title present:", doc.getElementById("main").innerHTML.includes(">Tasks<"));

  // Find whichever seeded study actually has abstracts (ACL Registry in the seed data — not
  // necessarily the first card once sorted by phase) and confirm ITS Abstract Submissions
  // section auto-expands. Note: clicking the "Studies" tab button while already ON that tab is
  // a no-op (detailStudyId isn't reset), so use the in-page back button to actually return to
  // the list between checks.
  doc.getElementById("back-btn").click();
  await wait(30);
  const allCards = [...doc.querySelectorAll('.study-row')];
  let foundAbstractsCase = false;
  for (const c of allCards) {
    c.click();
    await wait(30);
    if (doc.querySelector('[data-abs-status]')) {
      console.log("Abstract Submissions matches its phase:",
        (bodyDisplay(doc, "abstracts") === "") === window.eval(`sectionOpenForPhase("abstracts", ${JSON.stringify(window.eval("studyById(detailStudyId).phase"))})`));
      foundAbstractsCase = true;
      break;
    }
    doc.getElementById("back-btn").click();
    await wait(30);
  }
  console.log("Found a study with seeded abstracts to test against:", foundAbstractsCase);
  // back out to the studies list, then re-open the ORIGINAL card (MPFL) to resume the rest of the test
  doc.getElementById("back-btn").click();
  await wait(30);
  card.click();
  await wait(50);

  // Manually expand a collapsed section (Working Documents) and confirm the toggle works without a full re-render
  const wdToggle = doc.querySelector('[data-sec-toggle="workingDocs"]');
  const wasOpen = bodyDisplay(doc, "workingDocs") === "";
  wdToggle.click();
  console.log("Working Documents toggles on click:", (bodyDisplay(doc, "workingDocs") === "") === !wasOpen);
  wdToggle.click();
  console.log("...and toggles back:", (bodyDisplay(doc, "workingDocs") === "") === wasOpen);
  // Leave it open for the re-render check below.
  if (bodyDisplay(doc, "workingDocs") !== "") wdToggle.click();

  // Make an edit inside Working Documents (which triggers upsertStudy and a re-render) and confirm
  // the manual expand survives it. Done through Add a document, because the section now lists only
  // the types a study already holds — on a study with none there is no link box to type into.
  doc.getElementById("doc-add").click();
  await wait(80);
  doc.getElementById("doc-type").value = "overview";
  doc.getElementById("doc-link").value = "https://docs.example.com/overview";
  doc.getElementById("sheet-save").click();
  await wait(150);
  console.log("Manual expand survives an in-page edit re-render:", bodyDisplay(doc, "workingDocs") === "");

  // Force Milestones open (its starting state now depends on the phase), then collapse it and
  // confirm that manual choice survives an in-page edit.
  const msToggle = doc.querySelector('[data-sec-toggle="milestones"]');
  if (bodyDisplay(doc, "milestones") !== "") msToggle.click();
  msToggle.click();
  console.log("Milestones collapses on click:", bodyDisplay(doc, "milestones") === "none");
  const msNameField = doc.getElementById("ms-name");
  msNameField.value = "New test milestone";
  doc.getElementById("ms-add").click();
  await wait(50);
  console.log("Manual collapse of Milestones survives an in-page edit re-render:", bodyDisplay(doc, "milestones") === "none");

  // Leave the study and come back — should recompute fresh (Milestones open again since it now has content,
  // Working Documents open too since we added a link).
  const backBtn = doc.getElementById("back-btn");
  backBtn.click();
  await wait(50);
  card.click();
  await wait(50);
  console.log("Milestones matches its phase on a fresh open:",
    (bodyDisplay(doc, "milestones") === "") === !!window.eval(`studySectionState["milestones"]`));
  console.log("Working Documents matches its phase on a fresh open:",
    (bodyDisplay(doc, "workingDocs") === "") === window.eval(`sectionOpenForPhase("workingDocs", ${JSON.stringify(window.eval("studyById(detailStudyId).phase"))})`));

  // Open a DIFFERENT study — its section state should be independent / freshly computed, not inherit the previous study's manual toggles.
  doc.getElementById("back-btn").click();
  await wait(50);
  const cards = doc.querySelectorAll('.study-row');
  console.log("More than one study available for the cross-study test:", cards.length > 1);
  if (cards.length > 1) {
    cards[1].click();
    await wait(50);
    console.log("Second study's Working Documents recomputed fresh from ITS phase:",
      (bodyDisplay(doc, "workingDocs") === "") === !!window.eval(`studySectionState["workingDocs"]`));
  }

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
