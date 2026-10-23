// Dropping documents in, and adding several at once — 21 Oct 2026.
//
// FOUR COMPLAINTS, all from using it for real:
//
//   1. "it should allow a drag and drop into the working documents area and then ask the questions
//      about it when you add it to classify it" — dropping onto a NAMED slot worked, but that is
//      only useful once you know which slot a file belongs in, and a study with no documents has
//      no slots on screen at all. So the common case — a fresh study and a file in hand — had
//      nowhere to aim.
//   2. "the question dialogue box doesnt allow the drag and drop there" — the sheet looked like a
//      drop target and wasn't one.
//   3. "it wont let you contineu without hitting choose folder" — the only staged file lived
//      inside the <input type=file>, read as `.files[0]` at save time. Nothing else could put a
//      file there, so Add refused however the file had arrived.
//   4. "make sure you can upload mutlipel files in the same description/instance" — one file per
//      visit, re-answering the same two questions each time.
//
// The through-line in 1 and 3 is the same mistake: the file input was the source of truth. Staging
// is now a plain array that the picker, a drop on the sheet, and a drop on the section all write
// into, and Add reads only that array.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const USER = "test-user-1";
const now = new Date().toISOString();
const profile = {
  id: USER, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: { id: USER, email: "a@example.com", name: "Adam Yanke", position: "Clinician",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true,
    tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: true },
};
const STUDY = {
  id: "11111111-1111-5111-8111-111111111111", kind: "study", updated_at: now, workspace: "sports-yanke",
  data: { id: "11111111-1111-5111-8111-111111111111", title: "A knee study", phase: "Enrolling",
    pi: "Adam Yanke", team: ["Adam Yanke"], authors: [], docs: [], docSlots: {} },
};

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}

const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    win.supabase = { createClient: () => makeMockSupabase({ items: [profile, STUDY] }) };
  },
});
const w = dom.window;
const d = w.document;
const ev = (c) => w.eval(c);

// A File the jsdom build will carry through a DataTransfer-shaped object. The real event hands us
// a FileList; everything downstream only spreads it, so an array stands in exactly.
function fakeFile(name, size) {
  const f = new w.File(["x"], name, { type: "application/octet-stream" });
  Object.defineProperty(f, "size", { value: size === undefined ? 2048 : size });
  return f;
}
function dropOn(el, files) {
  const e = new w.Event("drop", { bubbles: true, cancelable: true });
  e.dataTransfer = { types: ["Files"], files, dropEffect: "" };
  el.dispatchEvent(e);
  return e;
}

(async () => {
  await new Promise(r => setTimeout(r, 700));
  ev(`tab = "studies"; openStudy(${JSON.stringify(STUDY.id)}); render();`);
  await new Promise(r => setTimeout(r, 250));

  console.log("\n-- 1. The whole section takes a drop, even with no documents yet --");
  let zone = d.querySelector("#main [data-docs-drop]");
  check("the section is a drop zone", !!zone);
  check("...and says so where somebody will read it",
    /Drag files anywhere into this box/.test(d.querySelector("#main").innerHTML));
  check("the study really has no documents yet",
    ev(`slotEntries(studyById(detailStudyId), "abstract").length`) === 0
    || ev(`DOC_SLOTS.concat([OTHER_SLOT]).every(t => slotEntries(studyById(detailStudyId), t.key).length === 0)`));

  // Nothing may be stored by the drop itself: the questions come first, and Cancel must undo it.
  const before = ev(`JSON.stringify(studyById(detailStudyId).docSlots || {})`);
  dropOn(zone, [fakeFile("knee-abstract-v3.docx")]);
  await new Promise(r => setTimeout(r, 120));
  check("dropping opens the classify sheet", !!d.getElementById("sheet"));
  check("...and files nothing until the questions are answered",
    ev(`JSON.stringify(studyById(detailStudyId).docSlots || {})`) === before);

  console.log("\n-- The dropped file is staged and named on the sheet --");
  let sheet = d.getElementById("sheet");
  check("the file is listed by name", /knee-abstract-v3\.docx/.test(sheet.innerHTML));
  check("Add as starts on upload, not link", sheet.querySelector("#doc-how").value === "upload");
  check("the link box is hidden", sheet.querySelector("#doc-link-row").style.display === "none");
  check("the type is guessed from the filename", sheet.querySelector("#doc-type").value === "abstract",
    sheet.querySelector("#doc-type").value);

  console.log("\n-- 3. Add works without ever touching the file picker --");
  check("the file input is empty — nothing was put in it",
    sheet.querySelector("#doc-file").files.length === 0);
  sheet.querySelector("#doc-desc").value = "Third pass, ready for Carla";
  d.getElementById("sheet-save").click();
  await new Promise(r => setTimeout(r, 400));
  check("the file was filed", ev(`slotEntries(studyById(detailStudyId), "abstract").length`) === 1,
    ev(`JSON.stringify(studyById(detailStudyId).docSlots)`));
  check("...under the description that was typed",
    ev(`(slotEntries(studyById(detailStudyId), "abstract")[0] || {}).label`) === "Third pass, ready for Carla");
  // closeSheet() lets the slide-out animation finish (320 ms) before removing the node, and it is
  // only called once the upload has resolved, so a fixed 400 ms wait raced the two. Wait for the
  // sheet to actually leave, up to 2 s, rather than for a guessed time.
  for (let i = 0; i < 40 && d.getElementById("sheet"); i++) await new Promise(r => setTimeout(r, 50));
  check("...and the sheet closed", !d.getElementById("sheet"));

  console.log("\n-- 2. The sheet is itself a drop target --");
  ev(`openAddDocSheet(studyById(detailStudyId), { store: async (f) => ({ id: uid(), kind: "file", name: f.name, label: "", by: me(), date: todayStr(), size: f.size }) })`);
  await new Promise(r => setTimeout(r, 120));
  sheet = d.getElementById("sheet");
  const dz = sheet.querySelector("#doc-drop");
  check("there is a drop area in the sheet", !!dz);
  check("it starts on link, with nothing staged yet", sheet.querySelector("#doc-how").value === "link");
  const dropEvent = dropOn(dz, [fakeFile("figure1.png"), fakeFile("figure2.png")]);
  await new Promise(r => setTimeout(r, 80));
  check("the drop is accepted, not left to the browser", dropEvent.defaultPrevented);
  check("both files are staged", /figure1\.png/.test(sheet.innerHTML) && /figure2\.png/.test(sheet.innerHTML));
  check("...and it switched itself to upload", sheet.querySelector("#doc-how").value === "upload");

  console.log("\n-- 4. Several files, one description --");
  sheet.querySelector("#doc-type").value = "other";
  sheet.querySelector("#doc-type").dispatchEvent(new w.Event("change"));
  await new Promise(r => setTimeout(r, 40));
  check("it says the description covers them all",
    /all 2 files/.test(sheet.querySelector("#doc-desc-note").textContent),
    sheet.querySelector("#doc-desc-note").textContent);
  sheet.querySelector("#doc-desc").value = "Figures for JBJS resubmission";
  d.getElementById("sheet-save").click();
  await new Promise(r => setTimeout(r, 500));
  const others = JSON.parse(ev(`JSON.stringify(slotEntries(studyById(detailStudyId), "other"))`));
  check("both files were filed", others.length === 2, others.map(e => e.name));
  check("...each carrying the one description",
    others.every(e => e.label === "Figures for JBJS resubmission"), others.map(e => e.label));
  check("...and they kept their own filenames",
    others.some(e => e.name === "figure1.png") && others.some(e => e.name === "figure2.png"));

  console.log("\n-- A single-document slot says where the extras will go, before you press Add --");
  ev(`openAddDocSheet(studyById(detailStudyId), { store: async (f) => ({ id: uid(), kind: "file", name: f.name, label: "", by: me(), date: todayStr(), size: f.size }) })`);
  await new Promise(r => setTimeout(r, 120));
  sheet = d.getElementById("sheet");
  dropOn(sheet.querySelector("#doc-drop"), [fakeFile("a.docx"), fakeFile("b.docx"), fakeFile("c.docx")]);
  await new Promise(r => setTimeout(r, 80));
  sheet.querySelector("#doc-type").value = "manuscript";          // single-document slot
  sheet.querySelector("#doc-type").dispatchEvent(new w.Event("change"));
  await new Promise(r => setTimeout(r, 40));
  const spill = sheet.querySelector("#doc-spill");
  check("the warning is showing", spill.style.display !== "none");
  check("...and names the file that will go there", /a\.docx/.test(spill.textContent), spill.textContent);
  check("...and says the other two go to Other Documents",
    /other 2/.test(spill.textContent) && /Other Documents/.test(spill.textContent), spill.textContent);
  const otherBefore = ev(`slotEntries(studyById(detailStudyId), "other").length`);
  d.getElementById("sheet-save").click();
  await new Promise(r => setTimeout(r, 600));
  check("the named slot got exactly one", ev(`slotEntries(studyById(detailStudyId), "manuscript").length`) === 1);
  check("...and nothing was dropped on the floor",
    ev(`slotEntries(studyById(detailStudyId), "other").length`) === otherBefore + 2,
    { before: otherBefore, after: ev(`slotEntries(studyById(detailStudyId), "other").length`) });

  console.log("\n-- Multi slots take everything, no warning --");
  ev(`openAddDocSheet(studyById(detailStudyId), { store: async (f) => ({ id: uid(), kind: "file", name: f.name, label: "", by: me(), date: todayStr(), size: f.size }) })`);
  await new Promise(r => setTimeout(r, 120));
  sheet = d.getElementById("sheet");
  dropOn(sheet.querySelector("#doc-drop"), [fakeFile("x.pdf"), fakeFile("y.pdf")]);
  await new Promise(r => setTimeout(r, 80));
  // The sheet opens on the first type in the list, which is a single-document slot, so two files
  // correctly warn. Choosing a multi slot must clear that warning rather than leaving it standing.
  check("a single-document type warns first", sheet.querySelector("#doc-spill").style.display !== "none");
  sheet.querySelector("#doc-type").value = "other";
  sheet.querySelector("#doc-type").dispatchEvent(new w.Event("change"));
  await new Promise(r => setTimeout(r, 40));
  check("no warning once Other Documents is chosen", sheet.querySelector("#doc-spill").style.display === "none");

  console.log("\n-- Staged files can be taken back out again --");
  const removeBtn = sheet.querySelector("[data-unstage]");
  check("there is a remove button per file", !!removeBtn);
  removeBtn.click();
  await new Promise(r => setTimeout(r, 40));
  check("removing one leaves the other", !/x\.pdf/.test(sheet.querySelector("#doc-staged").innerHTML)
    && /y\.pdf/.test(sheet.querySelector("#doc-staged").innerHTML));

  console.log("\n-- Add with nothing staged refuses, and says what to do --");
  sheet.querySelector("[data-unstage]").click();
  await new Promise(r => setTimeout(r, 40));
  d.getElementById("sheet-save").click();
  await new Promise(r => setTimeout(r, 120));
  check("the sheet is still open rather than closing on a no-op", !!d.getElementById("sheet"));

  console.log("\n-- Aiming at a named slot still files straight there, unasked --");
  // This is the behaviour that already worked and must not have been traded away for the new one.
  check("slot drops stop the event reaching the section handler",
    /zone\.addEventListener\("drop"[\s\S]{0,400}e\.stopPropagation\(\)/.test(html));
  check("the section handler is a separate zone", /\[data-docs-drop\]/.test(html));
  check("...and it opens the sheet rather than storing anything",
    /openAddDocSheet\(s, \{ files: \[\.\.\.files\], store: storeUploadedFile \}\)/.test(html));

  console.log("\n-- The store function is passed in, not reached for by name --");
  check("openAddDocSheet takes it as an option", /function openAddDocSheet\(s, opts\)/.test(html));
  check("...and both callers supply it",
    (html.match(/openAddDocSheet\(s, \{[^}]*store: storeUploadedFile/g) || []).length === 2);

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
