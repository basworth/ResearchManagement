// Working Documents now shows only the document types a study actually holds, with one
// "Add a document" button that asks type + link-or-upload. Previously every study displayed six
// empty boxes and the one real document was lost among them.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const ME = "11111111-1111-1111-1111-111111111111";
const EMPTY = "aaaaaaaa-0000-0000-0000-00000000000e";
const now = new Date().toISOString();
const base = (id, title, extra) => ({ id, kind: "study", updated_at: now, workspace: "sports-yanke",
  data: Object.assign({ id, title, nickname: "", phase: "Manuscript", design: "Retrospective (Non-Consented)",
    pi: "Adam Yanke", team: [], milestones: [], meetingNotes: [], authors: [], abstracts: [], docs: [] }, extra || {}) });
const items = [
  { id: ME, kind: "profile", updated_at: now, workspace: "sports-yanke",
    data: { id: ME, name: "Adam Yanke", email: "a@b.c", position: "Clinician", admin: true,
            reportsTo: "", alertEmail: "", linkedTo: "", alertEmailAsked: true, degreesAsked: true } },
  base(EMPTY, "A study with no documents yet"),
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now, workspace: "sports-yanke",
    data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} } }
];

const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items, userId: ME, email: "a@b.c" }) };
  }
});
const { window } = dom, doc = window.document;
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);
const wdZones = () => {
  const body = doc.querySelector('[data-sec-body="workingDocs"]') || doc.getElementById("main");
  return [...body.querySelectorAll("[data-slot-drop]")].map(z => z.dataset.slotDrop);
};
const open = () => window.eval(`detailStudyId = ${JSON.stringify(EMPTY)}; tab = "studies"; render();
                                studySectionState["workingDocs"] = true; render();`);

(async () => {
  await wait(400);
  window.eval("syncOnline = true;");
  open(); await wait(80);

  console.log("\n-- A study with no documents shows no empty boxes --");
  check("no document slots are rendered in Working Documents", wdZones().length === 0, wdZones());
  check("it says there's nothing yet", doc.getElementById("main").textContent.includes("No documents yet"));
  check("and offers one way in", !!doc.getElementById("doc-add"));

  console.log("\n-- Adding one by link --");
  doc.getElementById("doc-add").click();
  await wait(80);
  check("the sheet asks which type", !!doc.getElementById("doc-type"));
  check("...and offers every type a study can hold",
    doc.querySelectorAll("#doc-type option").length === window.eval("DOC_SLOTS.length + 1"),
    doc.querySelectorAll("#doc-type option").length);
  check("...and asks link or upload", !!doc.getElementById("doc-how"));

  doc.getElementById("doc-type").value = "sheet";
  doc.getElementById("doc-link").value = "https://docs.example.com/data-collection";
  doc.getElementById("sheet-save").click();
  await wait(250);

  check("the link is recorded under the chosen type",
    window.eval(`slotEntries(studyById(detailStudyId), "sheet").length`) === 1);
  check("...with the url given",
    window.eval(`slotEntries(studyById(detailStudyId), "sheet")[0].url`) === "https://docs.example.com/data-collection");

  console.log("\n-- Now that one exists, it's shown — and only it --");
  await wait(100);
  const slots = wdZones();
  check("exactly one document type is listed", slots.length === 1, slots);
  check("...the one that has something in it", slots[0] === "sheet", slots);
  check("the add button is still there for the next one", !!doc.getElementById("doc-add"));

  console.log("\n-- Switching to upload swaps the fields --");
  doc.getElementById("doc-add").click();
  await wait(80);
  const how = doc.getElementById("doc-how");
  check("the link box shows by default", doc.getElementById("doc-link-row").style.display !== "none");
  how.value = "upload";
  how.dispatchEvent(new window.Event("change"));
  await wait(50);
  check("choosing upload hides the link box", doc.getElementById("doc-link-row").style.display === "none");
  check("...and shows the file picker", doc.getElementById("doc-file-row").style.display !== "none");

  console.log("\n-- Nothing chosen, nothing added --");
  doc.getElementById("sheet-save").click();
  await wait(120);
  check("an empty upload adds nothing", window.eval(`slotEntries(studyById(detailStudyId), "sheet").length`) === 1);
  check("...and the sheet stays open", !!doc.getElementById("doc-how"));

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
