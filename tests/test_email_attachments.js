// Files on forwarded emails — 29 Oct 2026.
//
// Adam: "can the email scrubber read the image?" and "if I put a data sheet in there that does not
// contain PHI, you should automatically move it into the website in the appropriate location under
// the correct study." What these tests hold:
//   1. Server: an email with files goes to the reader; each file is read and checked for patient
//      information; anything that may identify a patient is never stored and adds nothing to the
//      text; clean files are filed under the study the email changed or the study the file names.
//   2. App: the meeting card lists the files — filed (with a link), refused (with why), or waiting
//      with a "File under…" picker; filing one puts it in the study's Documents; waiting files count
//      toward the red badge.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const ME = "test-user-1";
const now = new Date().toISOString();
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}
(async () => {
  const dir = PROJECT + "/supabase/functions/ingest-email";
  if (!fs.existsSync(dir + "/attachments.ts")) console.log("  skip  supabase/ not in this checkout");
  else {
    const att = fs.readFileSync(dir + "/attachments.ts", "utf8");
    const idx = fs.readFileSync(dir + "/index.ts", "utf8");
    console.log("\n-- Server --");
    check("an email with files goes to the reader", /if \(sender && ANTHROPIC_KEY && \(atts\.length \|\| looksLikeMeeting\(subject, raw\)\)\)/.test(idx));
    check("an email that is only files is accepted", /if \(!raw\.trim\(\) && !atts\.length\) return json/.test(idx));
    check("unsure counts as patient information", /phi: r\.containsPatientInfo !== false/.test(att) && /If you are unsure, answer true/.test(att));
    check("a file that may identify a patient contributes no text", /text: r\.containsPatientInfo === false \? String\(r\.text/.test(att)
      && /files\.filter\(\(f\) => f\.ok && !f\.phi && f\.text\)/.test(idx));
    check("...and is never stored", /if \(!f\.ok \|\| f\.phi\) \{ record\.files\.push\(\{ name: f\.name, stored: false/.test(idx));
    check("a file that can't be checked isn't stored", /can't be checked for patient information, so it wasn't stored/.test(att));
    check("over 10 MB isn't stored", /MAX_FILE_BYTES = 10 \* 1024 \* 1024/.test(att) && /too large to check/.test(att));
    check("images and PDFs are read as they are; Office files by their text", /type: "image", source/.test(att) && /type: "document", source/.test(att) && /\.\(docx\|xlsx\|pptx\)\$/.test(att));
    check("filed under the one study the email changed, else the study the file names", /record\.studyIds\.length === 1 \? allStudies\.find/.test(idx) && /studyByGuess\(f\.studyGuess, allStudies\)/.test(idx));
    check("filed into the study's Documents", /target\.docs\.push\(\{ id: fid, kind: "file", name: f\.name, label: "From email"/.test(idx));
    check("the reply lists every file and what happened to it", /ATTACHED FILES/.test(idx) && /choose its study in the tracker/.test(idx));
  }

  console.log("\n-- App --");
  const SID = "11111111-1111-1111-1111-111111111111";
  const g = { id: "m1", source: "meeting", status: "applied", createdAt: now, undoUntil: new Date(Date.now() + 864e5).toISOString(),
    subject: "New Study Idea", forwardedBy: ME, forwardedByName: "Adam Yanke", applied: [], notApplied: [], changes: [],
    parserVersion: 999, needsParse: false,
    files: [
      { id: "f1", name: "sheet.xlsx", size: 1000, stored: true, studyId: SID, study: "QMRI OCA" },
      { id: "f2", name: "infographic.png", size: 2000, stored: true, studyId: "" },
      { name: "clinic-photo.jpg", stored: false, why: "may contain patient information — not saved" },
    ] };
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items: [
        { id: ME, kind: "profile", updated_at: now, workspace: "sports-yanke", data: { id: ME, email: "a@e.com", name: "Adam Yanke", position: "Clinician", admin: true, alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 99, fieldsChosen: true } },
        { id: SID, kind: "study", updated_at: now, workspace: "sports-yanke", data: { id: SID, title: "QMRI OCA", phase: "Enrolling", pi: "Adam Yanke", docs: [] } },
        { id: "m1", kind: "suggestion", updated_at: now, workspace: "sports-yanke", data: g },
      ] }) };
    } });
  const w = dom.window;
  await new Promise(r => setTimeout(r, 900));
  w.eval(`tab = "settings"; render()`);
  await new Promise(r => setTimeout(r, 50));
  const card = w.document.getElementById("mtg-m1");
  const t = card ? card.textContent.replace(/\s+/g, " ") : "";
  check("the card lists the files", /ATTACHED FILES/.test(t), t);
  check("a filed one says where, with a link", /sheet\.xlsx — filed under QMRI OCA/.test(t) && !!card.querySelector(".mtg-file-link"));
  check("a refused one says why", /clinic-photo\.jpg — may contain patient information/.test(t));
  check("a waiting one has a File under… picker", !!card.querySelector('[data-mtg-file="m1"]'));
  check("a waiting file counts as something to do", w.eval("actionCounts().updates") >= 1);
  const sel = card.querySelector('[data-mtg-file="m1"]');
  sel.value = SID; sel.dispatchEvent(new w.Event("change"));
  await new Promise(r => setTimeout(r, 50));
  check("filing it puts it in the study's Documents", w.eval(`(studyById("${SID}").docs || []).some(d => d.id === "f2" && d.label === "From email")`));
  check("...and the card now says where it went", w.eval(`state.suggestions.find(x => x.id === "m1").files[1].studyId`) === SID);

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
