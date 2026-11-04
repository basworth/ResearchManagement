// Uploads always say what's happening — 4 Nov 2026.
//
// William Lee: "I tried to add a proof (pdf) to the working documents section of a study but when
// I clicked the add button nothing happened." The upload gave no sign it had started, and a file
// that couldn't be read threw out of the upload unseen.
//
// What these tests hold:
//   1. Pressing Add shows "Uploading…" and disables the button, so a second press can't double-upload.
//   2. A file that can't be read ends in a message, the sheet stays open, and Add works again.
//   3. A file over the limit is flagged in the list before Add, with what to do instead.
//   4. A normal upload still lands in the slot.
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
    data: { id: SID, title: "Proof study", phase: "Manuscript", pi: "Adam Yanke", team: ["William Lee"], milestones: [], docs: [] } },
];
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items, userId: ME, email: "w@b.c" }) };
  } });
const { window } = dom, doc = window.document;
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);
const toastText = () => [...doc.querySelectorAll(".toast")].map(t => t.textContent).join(" | ");
const openSheet = () => { window.eval(`detailStudyId = ${JSON.stringify(SID)}; tab = "studies"; studySectionState["workingDocs"] = true; render();`); doc.getElementById("doc-add").click(); };
const stage = (file) => {
  const input = doc.getElementById("doc-file");
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.onchange();
};

(async () => {
  await wait(500);
  window.eval("syncOnline = true;");

  console.log("\n-- Too large is flagged before Add --");
  openSheet(); await wait(50);
  const big = new window.File(["x"], "proof-big.pdf", { type: "application/pdf" });
  Object.defineProperty(big, "size", { value: 9 * 1048576 });
  stage(big);
  check("the staged file says it's over the limit and what to do", /over 8 MB/.test(doc.getElementById("doc-staged").textContent) && /link/.test(doc.getElementById("doc-staged").textContent),
    doc.getElementById("doc-staged").textContent);
  doc.getElementById("sheet-save").click(); await wait(100);
  check("Add then says it's too large, by name", /proof-big\.pdf is too large/.test(toastText()), toastText());
  check("...the sheet stays open and Add is usable again", !!doc.getElementById("sheet") && !doc.getElementById("sheet-save").disabled && doc.getElementById("sheet-save").textContent === "Add");

  console.log("\n-- A file that can't be read --");
  openSheet(); await wait(50);
  window.eval(`window.__RealFR = FileReader; FileReader = function () { this.readAsDataURL = () => setTimeout(() => this.onerror && this.onerror(new Error("x")), 30); };`);
  stage(new window.File(["%PDF-1.4"], "proof.pdf", { type: "application/pdf" }));
  doc.getElementById("sheet-save").click();
  await wait(5);
  check("Add shows it's uploading", /Uploading/.test(doc.getElementById("sheet-save").textContent), doc.getElementById("sheet-save").textContent);
  check("...and is disabled while it does", doc.getElementById("sheet-save").disabled === true);
  await wait(150);
  check("an unreadable file says so", /Couldn't read proof\.pdf/.test(toastText()), toastText());
  check("...the sheet stays open and Add works again", !!doc.getElementById("sheet") && !doc.getElementById("sheet-save").disabled);
  window.eval(`FileReader = window.__RealFR;`);

  console.log("\n-- A normal upload --");
  doc.getElementById("sheet-save").click();
  for (let i = 0; i < 40 && doc.getElementById("sheet"); i++) await wait(100);   // slower under the full suite
  const slots = JSON.parse(window.eval(`JSON.stringify(studyById(${JSON.stringify(SID)}).docSlots || {})`));
  const all = [].concat(...Object.values(slots).filter(Array.isArray));
  check("the file lands in the study", all.some(e => e.name === "proof.pdf" && e.kind === "file"), slots);
  check("...and the sheet closes", !doc.getElementById("sheet"));

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
