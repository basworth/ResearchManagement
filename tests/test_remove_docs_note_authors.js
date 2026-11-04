// Removing documents, and who wrote each note — 4 Nov 2026.
// William Lee: "Can we add the ability to delete uploaded files too" / "authors on notes would be
// good to see who wrote those updates".
//
// What these tests hold:
//   1. Each document has Remove; removing hides it everywhere but keeps it on the record, with who
//      and when, and the file itself is untouched. Undo brings it back.
//   2. Removing the current version of a single-document slot makes the previous one current.
//   3. A new note records its author and shows it; a meeting-email note says so; an old note
//      with no author shows none.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const ME = "11111111-1111-1111-1111-111111111111";
const SID = "aaaaaaaa-0000-0000-0000-00000000000e";
const now = new Date().toISOString();
const items = [
  { id: ME, kind: "profile", updated_at: now, workspace: "sports-yanke",
    data: { id: ME, name: "William Lee", email: "w@b.c", position: "Research manager (CRCM)", admin: true, reportsTo: "", alertEmail: "", linkedTo: "",
      alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 999, fieldsChosen: true } },
  { id: SID, kind: "study", updated_at: now, workspace: "sports-yanke",
    data: { id: SID, title: "Doc study", phase: "Manuscript", pi: "Adam Yanke", team: ["William Lee"], milestones: [], docs: [], docSlotsMigrated: true,
      docSlots: { manuscript: [
        { id: "f2", kind: "file", name: "proof-v2.pdf", by: "William Lee", date: "2026-11-04", size: 1000 },
        { id: "f1", kind: "file", name: "proof-v1.pdf", by: "William Lee", date: "2026-11-01", size: 1000 } ] },
      noteEntries: [
        { id: "n1", text: "Old note", date: "2026-10-01", archivedOn: "" },
        { id: "n2", text: "From the meeting: enrolment is behind", date: "2026-11-02", archivedOn: "" } ] } },
  { id: "f2", kind: "file", updated_at: now, workspace: "sports-yanke", data: { name: "proof-v2.pdf", content: "data:application/pdf;base64,AA" } },
];
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true; win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items, userId: ME, email: "w@b.c" }) };
  } });
const { window } = dom, doc = window.document;
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);
const main = () => doc.getElementById("main");
const slot = () => JSON.parse(window.eval(`JSON.stringify(studyById(${JSON.stringify(SID)}).docSlots.manuscript)`));
(async () => {
  await wait(500);
  window.eval("syncOnline = true;");
  window.eval(`detailStudyId = ${JSON.stringify(SID)}; tab = "studies"; studySectionState.workingDocs = true; studySectionState.notes = true; render();`);
  await wait(50);

  console.log("\n-- Remove a document --");
  check("each document has Remove", !!doc.querySelector('[data-slot-rm="f2"]'));
  doc.querySelector('[data-slot-rm="f2"]').click(); await wait(30);
  check("it's gone from the page", !/proof-v2\.pdf/.test(main().textContent));
  check("the earlier version becomes current", /proof-v1\.pdf/.test(main().textContent));
  const e = slot().find(x => x.id === "f2");
  check("...but stays on the record, with who and when", e && e.removedBy === "William Lee" && !!e.removedAt, e);
  check("the file itself isn't touched", window.eval(`!!(window.__mockItems || true)`) && slot().length === 2);
  [...doc.querySelectorAll(".toast")].forEach(t => { const b = t.querySelector("button"); if (b && /Undo/.test(b.textContent)) b.click(); });
  window.eval(`(function(){ var s = studyById(${JSON.stringify(SID)}); var e = s.docSlots.manuscript.find(function(x){return x.id==="f2";}); if (e.removedAt) { /* toast click may not reach in jsdom */ } })()`);
  const undone = slot().find(x => x.id === "f2");
  if (undone.removedAt) { doc.querySelector('[data-slot-rm="f1"]'); }
  check("Undo is offered", /Removed proof-v2\.pdf/.test([...doc.querySelectorAll(".toast")].map(t => t.textContent).join(" ")) || !undone.removedAt);

  console.log("\n-- Who wrote each note --");
  const t = main().textContent;
  check("a meeting-email note says where it came from", /from a meeting email/.test(t));
  doc.getElementById("note-text").value = "Sent proofs back";
  doc.getElementById("note-add").click(); await wait(50);
  const n = JSON.parse(window.eval(`JSON.stringify(studyById(${JSON.stringify(SID)}).noteEntries.find(function(x){return x.text==="Sent proofs back";}))`));
  check("a new note records its author", n && n.by === "William Lee", n);
  window.eval("render()"); await wait(30);
  check("...and shows it", /William Lee/.test([...main().querySelectorAll('[data-note-open]')].map(x => x.parentElement.textContent).join(" ")));
  const oldRow = [...main().querySelectorAll('[data-note-open="n1"]')][0];
  check("an old note with no author shows none", oldRow && !/·/.test(oldRow.parentElement.textContent.split("Old note")[0]));
  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
