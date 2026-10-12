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
  card.click();
  await wait(50);

  // --- Working Documents section ---
  console.log("Working Documents header present:", doc.body.textContent.includes("Working Documents"));
  // Working Documents lists only the types a study holds, so add the abstract through the new
  // Add a document flow first; its box then appears, which is what the rest of this checks.
  doc.getElementById("doc-add").click();
  await wait(100);
  doc.getElementById("doc-type").value = "abstract";
  doc.getElementById("doc-link").value = "https://docs.example.com/seed-abstract";
  doc.getElementById("sheet-save").click();
  await wait(200);
  const wdAbstract = doc.querySelector('[data-slot-link="abstract"]');
  console.log("Working Abstract slot present:", !!wdAbstract);
  // Slots save on the Add link button rather than on blur, so the click IS the save.
  wdAbstract.value = "https://docs.example.com/working-abstract";
  doc.querySelector('[data-slot-save="abstract"]').click();
  await wait(150);
  console.log("Working abstract persisted after re-render:", doc.body.innerHTML.includes("docs.example.com/working-abstract"));
  console.log("Open link appears for the working abstract:", doc.body.innerHTML.includes("docs.example.com/working-abstract"));

  // --- Edit form: Phase = Revisions Required ---
  const editBtn = doc.getElementById("edit-study-btn");
  editBtn.click();
  await wait(50);
  const phaseSel = doc.getElementById("f-phase");
  console.log("Phase options include Revisions Required:", [...phaseSel.options].some(o => o.value === "Revisions Required"));
  phaseSel.value = "Revisions Required";
  phaseSel.dispatchEvent(new window.Event("change"));
  await wait(20);
  // Revision dates left Edit Study on 2026-09-15 — manuscript tracking moved to its own section
  // on the study page, so "day to day tracking" no longer means opening Edit Study. They're set
  // directly on the record here; the section itself is covered by test_journal_decision.js.
  window.eval(`(function(){
    var s = state.studies[0];
    s.decision = "Major revision";
    s.revisionsReceivedDate = "2026-06-01";
    s.revisionsDeadline = "2026-07-01";
    upsertStudy(s);
  })();`);

  // --- Grant info ---
  // Grant fields also left Edit Study in the 2026-09-15 restructure; they live in the
  // "Grant & Award Funding" section on the study page now. Set on the record directly.
  window.eval(`(function(){
    var s = state.studies[0];
    s.grant = { amount: "$25,000", source: "OREF", awardDate: "2026-01-15",
                balance: "$18,200", expirationDate: "", balanceUpdatedDate: "2026-07-01" };
    upsertStudy(s);
  })();`);

  const saveBtn = doc.getElementById("sheet-save");
  saveBtn.click();
  await wait(50);

  // Both sections must be open for their fields to be in the HTML.
  window.eval(`studySectionState["manuscript"] = true; studySectionState["grant"] = true; render();`);
  await wait(60);
  let detailHTML = doc.getElementById("main").innerHTML;
  console.log("Detail shows Revisions received:", detailHTML.includes("Revisions received"));
  console.log("Detail shows Revisions due:", detailHTML.includes("Revisions due"));
  console.log("Detail shows Grant heading:", detailHTML.includes("Grant &amp; Award Funding") || doc.body.textContent.includes("Grant & Award Funding"));
  console.log("Detail shows grant amount:", detailHTML.includes("$25,000"));
  console.log("Detail shows grant source:", detailHTML.includes("OREF"));
  console.log("Phase badge shows Revisions Required:", detailHTML.includes("Revisions Required"));

  // --- Revision Documents section ---
  // Revision Documents is no longer a section of its own — it lives inside Manuscript Submission,
  // and only once the decision is a minor or major revision. See test_doc_slots.js.
  console.log("Revision slots present:", ["revComments","revManuscript","revResponse"].every(k => !!doc.querySelector(`[data-slot-link="${k}"]`)));
  const revLink = doc.querySelector('[data-slot-link="revManuscript"]');
  revLink.value = "https://docs.example.com/revised-manuscript";
  doc.querySelector('[data-slot-save="revManuscript"]').click();
  await wait(150);
  console.log("Revised manuscript link persisted:", doc.body.innerHTML.includes("docs.example.com/revised-manuscript"));

  // Uploading a revision document. The dedicated #revdoc-file input is gone — every slot now
  // shares one upload control — so this drives the slot's own Upload button instead.
  //
  // The old assertion that followed ("Manuscript & Documents does NOT show the revision file")
  // has no meaning any more: that section no longer exists, which is a stronger guarantee than
  // the separation it was checking. test_doc_slots.js covers where revision documents land.
  console.log("Each revision slot has its own Upload:", ["revComments","revManuscript","revResponse"].every(k => !!doc.querySelector(`[data-slot-up="${k}"]`)));

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
