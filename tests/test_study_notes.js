// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Study notes: moved out of Edit Study into their own collapsible section, converted from a
// single free-text blob into dated entries, plus an archive lane (batch + per-entry).
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const now = new Date().toISOString();
// LOCAL calendar date, matching the app. toISOString() is UTC and after 7pm Chicago already
// reports tomorrow, which is the off-by-one the app itself used to have.
const today = (() => {
  const d = new Date();
  const p2 = (x) => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
})();
const mockItems = [
  // s1 carries a LEGACY free-text notes blob, including the "Area:" tag that drives the emblem.
  { id: "s1", kind: "study", data: { id: "s1", title: "Legacy Notes Study", nickname: "Legacy", pi: "Yanke", team: ["Navya"], design: "Prospective (Consented)", phase: "Concept", priority: "Medium", irb: "ORA-1", milestones: [],
      notes: "Area: Knee\nOld running notes from the edit form." }, updated_at: now },
  { id: "s2", kind: "study", data: { id: "s2", title: "Empty Notes Study", nickname: "Empty", pi: "Yanke", team: ["Navya"], design: "Prospective (Consented)", phase: "Concept", priority: "Medium", irb: "ORA-2", milestones: [], notes: "" }, updated_at: now },
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke", "Navya"], degrees: {} }, updated_at: now }
];

const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.prompt = () => "";
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items: mockItems }) };
  }
});
const { window } = dom;
const doc = window.document;
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function q(sel) { return doc.querySelector(sel); }
function main() { return doc.getElementById("main").innerHTML; }
async function openStudy(id) { window.eval(`tab = "studies"; openStudy("${id}"); render();`); await wait(80); }
async function expandNotes() {
  const t = [...doc.querySelectorAll("[data-sec-toggle]")].find(e => e.dataset.secToggle === "notes");
  const body = doc.querySelector('[data-sec-body="notes"]');
  if (body && body.style.display === "none") { t.click(); await wait(50); }
}
function liveNotes(id) {
  return JSON.parse(window.eval(`JSON.stringify(state.studies.find(x=>x.id==="${id}").noteEntries.filter(n=>!n.archivedOn))`));
}
function archivedNotes(id) {
  return JSON.parse(window.eval(`JSON.stringify(state.studies.find(x=>x.id==="${id}").noteEntries.filter(n=>n.archivedOn))`));
}
let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

(async () => {
  await wait(300);
  window.eval('upsertProfile("Adam Yanke")');
  window.eval("syncOnline = true");
  await wait(60);

  console.log("\n-- Migration of the legacy free-text blob --");
  check("Legacy notes become exactly one dated entry", liveNotes("s1").length === 1, liveNotes("s1"));
  check("...preserving the original text verbatim",
    liveNotes("s1")[0].text === "Area: Knee\nOld running notes from the edit form.", liveNotes("s1")[0]);
  check("...stamped with a date", /^\d{4}-\d{2}-\d{2}$/.test(liveNotes("s1")[0].date), liveNotes("s1")[0].date);
  check("...and starting un-archived", liveNotes("s1")[0].archivedOn === "");
  check("A study with no notes migrates to an empty list",
    window.eval('JSON.stringify(state.studies.find(x=>x.id==="s2").noteEntries)') === "[]");

  // The guard that stops the legacy blob re-seeding a duplicate on every load.
  window.eval("migrate(); migrate();");
  await wait(40);
  check("Re-running migrate does NOT duplicate the seeded entry", liveNotes("s1").length === 1, liveNotes("s1").length);

  console.log("\n-- The Area: emblem tag still resolves --");
  check("studyArea reads the tag out of the legacy blob", window.eval('studyArea(state.studies.find(x=>x.id==="s1"))') === "knee");

  console.log("\n-- Notes are gone from Edit Study --");
  await openStudy("s1");
  q("#edit-study-btn").click();
  await wait(80);
  check("No notes textarea in the study form", !doc.getElementById("f-notes"));
  q("#sheet-cancel").click();
  await wait(60);

  console.log("\n-- Notes render as their own collapsible section --");
  await openStudy("s1");
  const toggle = [...doc.querySelectorAll("[data-sec-toggle]")].find(e => e.dataset.secToggle === "notes");
  check("There's a Notes section toggle", !!toggle);
  check("...titled Notes", toggle && toggle.textContent.includes("Notes"));
  check("...auto-expanded because it has live notes", q('[data-sec-body="notes"]').style.display !== "none");
  check("...rendering the note text", main().includes("Old running notes from the edit form."));
  check("The header card no longer prints the raw notes blob",
    !doc.querySelector(".detail-h").innerHTML.includes("Old running notes from the edit form."));

  console.log("\n-- Adding notes inline --");
  await expandNotes();
  doc.getElementById("note-text").value = "Screen failures running high";
  // Dated later than the migrated legacy note (which got stamped with today) so the
  // newest-first ordering is actually being exercised.
  doc.getElementById("note-date").value = "2026-12-01";
  doc.getElementById("note-add").click();
  await wait(80);
  check("Adding a note appends it", liveNotes("s1").length === 2, liveNotes("s1").length);
  check("...with the date that was picked", liveNotes("s1").some(n => n.date === "2026-12-01"));
  await expandNotes();
  const firstRow = main().indexOf("Screen failures running high");
  const secondRow = main().indexOf("Old running notes from the edit form.");
  check("Newest note sorts to the top", firstRow > -1 && secondRow > -1 && firstRow < secondRow, [firstRow, secondRow]);

  doc.getElementById("note-text").value = "   ";
  doc.getElementById("note-add").click();
  await wait(60);
  check("An all-whitespace note is refused", liveNotes("s1").length === 2, liveNotes("s1").length);

  console.log("\n-- Per-entry archive --");
  await expandNotes();
  const target = liveNotes("s1").find(n => n.text === "Screen failures running high");
  q(`[data-note-arch="${target.id}"]`).click();
  await wait(80);
  check("Archiving one note removes it from the live list", liveNotes("s1").length === 1, liveNotes("s1"));
  check("...without deleting it", archivedNotes("s1").length === 1);
  check("...stamped with today's archive date", archivedNotes("s1")[0].archivedOn === today, archivedNotes("s1")[0].archivedOn);
  await expandNotes();
  check("An Archived heading appears", main().includes("Archived"));
  check("A single-note group says 'note', not 'notes'", /·\s*1 note[^s]/.test(main()));
  check("The archived text is still reachable in the DOM", main().includes("Screen failures running high"));

  console.log("\n-- Unarchive --");
  await expandNotes();
  q(`[data-note-unarch="${target.id}"]`).click();
  await wait(80);
  check("Unarchiving returns it to the live list", liveNotes("s1").length === 2, liveNotes("s1").length);
  check("...and clears the archive stamp", archivedNotes("s1").length === 0);

  console.log("\n-- Archive all --");
  await expandNotes();
  check("The button counts the live notes", (q("#note-archive-all") || {}).textContent === "Archive all (2)",
    q("#note-archive-all") && q("#note-archive-all").textContent);
  q("#note-archive-all").click();
  await wait(80);
  check("Every live note is swept away", liveNotes("s1").length === 0, liveNotes("s1"));
  check("...all into one group", archivedNotes("s1").length === 2);
  check("...sharing one archive date", new Set(archivedNotes("s1").map(n => n.archivedOn)).size === 1);
  check("The Archive all button disappears when nothing is live", !q("#note-archive-all"));

  console.log("\n-- Archived groups collapse and expand --");
  await expandNotes();
  const groupHeader = q(`[data-note-group="${today}"]`);
  const groupBody = q(`[data-note-group-body="${today}"]`);
  check("A dated group header exists", !!groupHeader);
  check("...labelled with the count", groupHeader && groupHeader.textContent.includes("2 notes"), groupHeader && groupHeader.textContent.trim());
  check("Archive all leaves the group COLLAPSED", groupBody && groupBody.style.display === "none", groupBody && groupBody.style.display);
  groupHeader.click();
  await wait(50);
  check("Clicking the header opens it", q(`[data-note-group-body="${today}"]`).style.display !== "none");
  check("...revealing the archived note text", q(`[data-note-group-body="${today}"]`).innerHTML.includes("Screen failures"));
  q(`[data-note-group="${today}"]`).click();
  await wait(50);
  check("Clicking again closes it", q(`[data-note-group-body="${today}"]`).style.display === "none");

  console.log("\n-- Section auto-collapses when everything is archived --");
  await openStudy("s2");     // leave, then come back so section state is recomputed
  await openStudy("s1");
  // Notes is relevant in every phase, so it now opens regardless of whether anything is live —
  // phase decides, not content (see PHASE_SECTIONS).
  check("Notes section still opens, since notes matter in every phase",
    q('[data-sec-body="notes"]').style.display !== "none");
  check("The Area: emblem survives archiving", window.eval('studyArea(state.studies.find(x=>x.id==="s1"))') === "knee");

  console.log("\n-- Delete really deletes --");
  await expandNotes();
  q(`[data-note-group="${today}"]`).click();
  await wait(50);
  const doomed = archivedNotes("s1")[0];
  q(`[data-note-del="${doomed.id}"]`).click();
  await wait(80);
  check("Deleting drops the entry entirely", archivedNotes("s1").length === 1, archivedNotes("s1").length);

  console.log("\n-- Empty state --");
  await openStudy("s2");
  await expandNotes();
  check("A study with no notes shows the empty prompt", main().includes("No notes yet"));
  check("...and offers no Archive all button", !q("#note-archive-all"));

  console.log("\n-- Offline edits are still blocked --");
  window.eval("syncOnline = false");
  await openStudy("s2");
  await expandNotes();
  doc.getElementById("note-text").value = "Should not save";
  doc.getElementById("note-add").click();
  await wait(80);
  check("Adding a note offline is refused", liveNotes("s2").length === 0, liveNotes("s2"));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
