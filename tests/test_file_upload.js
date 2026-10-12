// Uploads write straight to the table rather than through pushItem, so they need the workspace
// stamp applied by hand. They didn't have it from 9 Oct, and every upload was refused by the
// database while the app blamed the connection. Also covers drag-and-drop onto a document slot.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const ME = "11111111-1111-1111-1111-111111111111";
const STUDY = "aaaaaaaa-0000-0000-0000-000000000001";
const now = new Date().toISOString();
const items = [
  { id: ME, kind: "profile", updated_at: now, workspace: "sports-yanke",
    data: { id: ME, name: "Adam Yanke", email: "adam.yanke@rushortho.com", position: "Clinician",
            admin: true, reportsTo: "", alertEmail: "", linkedTo: "", alertEmailAsked: true, degreesAsked: true } },
  { id: STUDY, kind: "study", updated_at: now, workspace: "sports-yanke",
    data: { id: STUDY, title: "Meniscal repair outcomes", nickname: "Meniscus", phase: "Manuscript",
            design: "Retrospective (Non-Consented)", pi: "Adam Yanke", team: [], milestones: [],
            meetingNotes: [], authors: [], abstracts: [], docs: [] } },
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now, workspace: "sports-yanke",
    data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} } }
];

const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items, userId: ME, email: "adam.yanke@rushortho.com" }) };
  }
});
const { window } = dom, doc = window.document;
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);

function fakeFile(name, text) {
  const f = new window.File([text], name, { type: "application/pdf" });
  return f;
}
function dropOn(el, files) {
  const e = new window.Event("drop", { bubbles: true, cancelable: true });
  e.dataTransfer = { files, types: ["Files"], dropEffect: "" };
  el.dispatchEvent(e);
  return e;
}

(async () => {
  await wait(400);
  window.eval(`syncOnline = true; detailStudyId = ${JSON.stringify(STUDY)}; tab = "studies"; render();
               studySectionState["workingDocs"] = true; render();`);
  await wait(80);

  console.log("\n-- Every document slot is a drop target --");
  const zones = doc.querySelectorAll("[data-slot-drop]");
  check("slots advertise themselves as drop targets", zones.length > 0, zones.length);
  // The invitation to drop lives inside a slot that is rendered but empty — on this study the
  // Manuscript Submission slots. Working Documents itself is empty, so it says so instead.
  // Every empty slot says so, including the ones with their own wording — dropping is new, and
  // an affordance nobody is told about may as well not exist.
  const emptyTexts = [...doc.querySelectorAll("[data-slot-drop]")].map(z => z.textContent);
  check("every empty slot invites a drop", emptyTexts.length > 0 && emptyTexts.every(t => /drop a file here/i.test(t)),
    emptyTexts.map(t => t.replace(/\s+/g, " ").trim().slice(0, 60)));
  check("...and Working Documents says it holds nothing yet",
    doc.getElementById("main").textContent.includes("No documents yet"));

  console.log("\n-- Dropping a file uploads it into that slot --");
  const zone = doc.querySelector('[data-slot-drop="abstract"]') || zones[0];
  const key = zone.dataset.slotDrop;
  dropOn(zone, [fakeFile("draft-abstract.pdf", "%PDF-1.4 hello")]);
  await wait(300);
  const stored = items.filter(r => r.kind === "file");
  check("the file reached the database", stored.length === 1, stored.length);
  check("...carrying the workspace stamp", stored[0] && stored[0].workspace === "sports-yanke", stored[0] && stored[0].workspace);
  check("...and is recorded on the study",
    window.eval(`(slotEntries(studyById(detailStudyId), ${JSON.stringify(key)}) || []).length`) === 1);
  check("...under its own filename",
    window.eval(`(slotEntries(studyById(detailStudyId), ${JSON.stringify(key)})[0] || {}).name`) === "draft-abstract.pdf");

  console.log("\n-- A refused upload records nothing --");
  // Exactly the live failure: the database rejects the row. Nothing may be left on the study,
  // or it would list a document that doesn't exist.
  const before = window.eval(`slotEntries(studyById(detailStudyId), "overview").length`);
  window.eval(`window.__realUpsert = sb.from;`);
  window.eval(`sb.from = (t) => ({ upsert: () => Promise.resolve({ error: { message: "new row violates row-level security policy", code: "42501" } }) });`);
  const zone2 = doc.querySelector('[data-slot-drop="overview"]');
  if (zone2) { dropOn(zone2, [fakeFile("rejected.pdf", "x")]); await wait(250); }
  check("nothing is recorded on the study when the database refuses",
    window.eval(`slotEntries(studyById(detailStudyId), "overview").length`) === before);
  check("...and the message says refused, not 'check connection'",
    (doc.body.textContent.match(/refused/i) || []).length > 0, doc.getElementById("toast") && doc.getElementById("toast").textContent);
  window.eval(`sb.from = window.__realUpsert;`);

  console.log("\n-- A stray drop doesn't navigate the page away --");
  const strayTarget = doc.getElementById("main");
  const ev = new window.Event("dragover", { bubbles: true, cancelable: true });
  ev.dataTransfer = { files: [], types: ["Files"], dropEffect: "" };
  window.dispatchEvent(ev);
  check("dragging a file over the page is cancelled", ev.defaultPrevented);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
