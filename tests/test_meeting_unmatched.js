// "No study matched" items — 4 Nov 2026.
//
// Adam: "for the no study matched items when i send an email, we should have an option to delete
// them, or assign them to a study via a dropdown/search field".
//
// What these tests hold:
//   1. An unmatched item has a type-to-search study field and a Remove button; a matched one doesn't.
//   2. Picking a study puts the item (and what was heard) in that study's Notes, and clears it from the card.
//   3. Remove clears it from the card, is recorded (never erased), and Undo brings it back.
//   4. Someone who can't act on the meeting gets neither control.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}
const now = new Date().toISOString();
const U = "test-user-1";
const prof = (admin) => ({ id: U, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: { id: U, email: "a@example.com", name: admin ? "Adam Yanke" : "Casey Student", position: admin ? "Clinician" : "Research Assistant",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 999, fieldsChosen: true, linkedTo: "", admin: !!admin } });
const study = (id, title, nickname) => ({ id, kind: "study", updated_at: now, workspace: "sports-yanke",
  data: { id, title, nickname, pi: "Adam Yanke", team: ["Adam Yanke", "Casey Student"], phase: "Concept" } });
const meeting = () => ({ id: "mtg1", kind: "suggestion", updated_at: now, workspace: "sports-yanke", data: {
  id: "mtg1", source: "meeting", status: "applied", createdAt: now, undoUntil: new Date(Date.now() + 48 * 3600e3).toISOString(),
  subject: "Fwd: lab meeting", forwardedBy: "someone-else", forwardedByName: "Will Lee", repliedTo: ["x@example.com"], copied: [],
  applied: [],
  notApplied: [
    { text: "Order the new dynamometer", why: "nothing in the tracker to put it in", evidence: "we need a dynamometer", study: "", studyId: "" },
    { text: "Draft a poster abstract", why: "nothing in the tracker to put it in", study: "", studyId: "" },
    { text: "Task: Excel subject tracker", why: "held — only 30% sure", study: "Knee study", studyId: "k1" },
  ] } });
function boot(admin) {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items: [prof(admin), study("k1", "Knee strength after OCA", "Knee study"),
        study("h1", "Hip arthroscopy outcomes", "Hip study"), meeting()] }) };
    } });
  return dom.window;
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const w = boot(true); await wait(800);
  const d = w.document;
  w.eval(`tab = "settings"; render()`); await wait(50);
  const card = () => d.getElementById("mtg-mtg1");
  check("the card is shown", !!card());
  check("each unmatched item gets a study search and a Remove", d.querySelectorAll('[data-mtg-place="mtg1"]').length === 2
    && d.querySelectorAll('[data-mtg-dismiss="mtg1"]').length === 2, d.querySelectorAll('[data-mtg-place="mtg1"]').length);
  const inp = d.querySelector('[data-mtg-place="mtg1"][data-mtg-rid="n0"]');
  check("...a search field with the studies to pick from", inp.getAttribute("list") && d.getElementById(inp.getAttribute("list")).querySelectorAll("option").length === 2);

  console.log("\n-- Add to a study --");
  inp.value = "nonsense"; inp.onchange(); await wait(20);
  check("typing something that isn't a study changes nothing", !w.eval(`state.suggestions[0]["reviewed:n0"]`));
  const inp2 = d.querySelector('[data-mtg-place="mtg1"][data-mtg-rid="n0"]');
  inp2.value = "Hip arthroscopy outcomes"; inp2.onchange(); await wait(20);
  const notes = JSON.parse(w.eval(`JSON.stringify(studyById("h1").noteEntries || [])`));
  check("it lands in that study's Notes, with what was heard", notes.length === 1 && /Order the new dynamometer/.test(notes[0].text) && /we need a dynamometer/.test(notes[0].text) && /lab meeting/.test(notes[0].text), notes);
  check("...and leaves the card", !/Order the new dynamometer/.test(card().textContent));
  check("...recorded with where it went", w.eval(`state.suggestions[0]["reviewed:n0"].placedIn`) === "h1");

  console.log("\n-- Remove --");
  d.querySelector('[data-mtg-dismiss="mtg1"][data-mtg-rid="n1"]').click(); await wait(20);
  check("Remove takes it off the card", !/Draft a poster abstract/.test(card() ? card().textContent : ""));
  check("...recorded, not erased", w.eval(`state.suggestions[0]["reviewed:n1"].dismissed`) === true && w.eval(`state.suggestions[0].notApplied.length`) === 3);
  w.eval(`dismissMeetingItem("mtg1", "n1", true)`); await wait(20);
  check("Undo brings it back", /Draft a poster abstract/.test(card().textContent));
  check("the matched held item has neither control", !d.querySelector('[data-mtg-place="mtg1"][data-mtg-rid="n2"]'));

  console.log("\n-- Someone who can't act on the meeting --");
  const w2 = boot(false); await wait(800);
  w2.eval(`tab = "settings"; render()`); await wait(50);
  check("no controls", !w2.document.querySelector("[data-mtg-place]") && !w2.document.querySelector("[data-mtg-dismiss]"));

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
