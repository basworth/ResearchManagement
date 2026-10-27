// Meeting transcripts by email: every action item applied, with an undo record — 26 Oct 2026.
//
// Adam: do "all the action items for a study and give a summary back over email ... to the same
// people that were on the email", with undo "if the reviewer doesn't like them", undo for 2 days,
// and "keep a history of all changes". The model only READS the meeting; meeting.ts decides what
// is allowed. These tests feed it a reply shaped like the model's and check that decision: wrong
// study ids, unsure items, and patient names never reach the tracker, and every change applied
// carries exactly what is needed to reverse it.
const fs = require("fs");
const path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "supabase", "functions", "ingest-email", "meeting.ts"), "utf8");
if (!fs.existsSync(path.join(__dirname, "..", "supabase", "functions", "ingest-email", "meeting.ts"))) { console.log("  skip (no supabase folder)"); process.exit(0); }
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}
function toJs(src) {
  const mod = require("module");
  if (typeof mod.stripTypeScriptTypes === "function") return mod.stripTypeScriptTypes(src);
  const os = require("os"), { execFileSync } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-"));
  fs.writeFileSync(path.join(dir, "m.ts"), src);
  const tsc = path.join(path.dirname(require.resolve("typescript/package.json")), "bin", "tsc");
  try { execFileSync(process.execPath, [tsc, "--target", "es2020", "--outDir", dir, path.join(dir, "m.ts")], { stdio: "ignore" }); } catch (_) {}
  return fs.readFileSync(path.join(dir, "m.js"), "utf8");
}
const js = toJs(SRC.replace(/^export\s+/gm, ""));
const M = new Function(js + "\nreturn { looksLikeMeeting, studyContext, applyMeeting, canonPerson, redactAll, summaryEmail, threadRecipients, MEETING_UNDO_HOURS, tagVocabulary, extractPrompt };")();

const studies = () => [
  { id: "ipfi", nickname: "Integrative PFI", title: "An Integrative Study of Cartilage Ultrastructure, Bone Morphology, and Synovial Fluid Biomarkers", phase: "Enrolling",
    team: ["Adam Yanke", "Will"], enrollCurrent: "0", enrollTarget: "50", grant: { enabled: true, source: "RIRC" }, noteEntries: [], milestones: [] },
  { id: "mdakp", nickname: "MDAKP", title: "Multidisciplinary Approach to Anterior Knee Pain", phase: "Enrolling",
    team: ["Adam Yanke", "Brian Cole", "Catherine Yuh"], enrollCurrent: "7", enrollTarget: "30", grant: { source: "AOSSM" } },
  { id: "comp", nickname: "SSM Composite Study", title: "SSM - STTTG, PTLTR, TTTG", phase: "Manuscript",
    team: ["Adam Yanke"], milestones: [{ name: "Submit manuscript", date: "2026-12-31", done: false }], abstracts: [{ id: "ab1", meeting: "AANA 2026", status: "Submitted" }] },
  { id: "pub", title: "Old paper", phase: "Published" },
];
const roster = ["Adam Yanke", "Brian Cole", "Catherine Yuh", "Thomas Turinske", "William Lee", "Morgan Smith"];
let n = 0;
const env = { uid: () => "u" + (++n), today: "2026-10-26", by: "Adam Yanke" };

console.log("\n-- Recognising a meeting --");
check("a timestamped transcript is a meeting", M.looksLikeMeeting("Fwd: lab", Array.from({ length: 8 }, (_, i) => `00:0${i}:04 Speaker ${i % 2 + 1}\nsomething said`).join("\n")));
check("so is a subject that says so", M.looksLikeMeeting("Research meeting notes 10/26", "short"));
check("a journal letter is not", !M.looksLikeMeeting("Decision on manuscript AJSM-26-1234", "Dear Dr. Yanke,\nWe regret to inform you..."));
check("published studies are left out of what the model sees", !M.studyContext(studies()).some(s => s.id === "pub"));

console.log("\n-- Applying what the meeting decided --");
const S = studies();
const out = M.applyMeeting({
  updates: [
    { type: "enrollment", studyId: "mdakp", enrolled: 13, evidence: "up to thirteen", confidence: 0.95 },
    { type: "addTeamMember", studyId: "mdakp", name: "Morgan", evidence: "you got to add Morgan on there", confidence: 0.9 },
    { type: "title", studyId: "ipfi", title: "An Integrative Study of Cartilage Ultrastructure and Bone Morphology", evidence: "synovial fluid dropped in Amendment 2", confidence: 0.85 },
    { type: "updateMilestone", studyId: "comp", milestoneName: "Submit manuscript", date: "2026-11-30", evidence: "end of year is way too long", confidence: 0.8 },
    { type: "addTask", studyId: "comp", task: "Segment the control cohort with cartilage", assignees: ["Thomas"], due: "2026-10-30", evidence: "knock out the control cohort this week", confidence: 0.9 },
    { type: "addNote", studyId: "ipfi", note: "None enrolled yet; under-18 amendment pending. Ladonna New declined.", evidence: "Ladonna New couldn't drive in", confidence: 0.9 },
    { type: "abstract", studyId: "comp", meeting: "AOSSM 2026", status: "Submitted", evidence: "submitted to AANA and AOSSM", confidence: 0.8 },
    { type: "abstract", studyId: "comp", meeting: "AANA 2026", status: "Submitted", evidence: "already there", confidence: 0.9 },
    { type: "newStudy", title: "Version, torsion and knee rotation vs bone shape", pi: "Adam Yanke", team: ["Jacob Ackerman"], regions: ["knee", "Knee"], topics: ["patellofemoral INSTABILITY", "Torsion"], evidence: "that could be its own paper", confidence: 0.75 },
    { type: "enrollment", studyId: "made-up-id", enrolled: 4, evidence: "?", confidence: 0.9 },
    { type: "phase", studyId: "comp", phase: "Submitted", evidence: "maybe", confidence: 0.2 },
    { type: "addNote", studyId: "pub", note: "Johannes may want to collaborate", evidence: "ran into Johannes", confidence: 0.8 },
    { type: "title", studyId: "pub", title: "Retitled", evidence: "", confidence: 0.9 },
  ],
  notMapped: [{ text: "TJ to check whether the clinical scanner has the scout sequence", why: "no study" }],
  patientIdentifiers: ["Ladonna New"],
}, S, roster, env);
const by = (t) => out.applied.filter(a => a.type === t);
const st = (id) => S.find(s => s.id === id);
check("enrollment set, with its old value kept", st("mdakp").enrollCurrent === "13" && by("enrollment")[0].from === "7");
check("'Morgan' becomes the roster's Morgan Smith", st("mdakp").team.includes("Morgan Smith"));
check("the title is corrected", /Bone Morphology$/.test(st("ipfi").title) && by("title")[0].undo.prev.includes("Synovial"));
check("the milestone moves, and its old date is kept for undo", st("comp").milestones[0].date === "2026-11-30" && by("updateMilestone")[0].undo.prev.date === "2026-12-31");
check("a task is created for the study, assigned on the roster", out.newTasks.length === 1 && out.newTasks[0].studyId === "comp" && out.newTasks[0].assignees[0] === "Thomas Turinske" && out.newTasks[0].due === "2026-10-30");
check("a new abstract is added; one already recorded is not repeated", st("comp").abstracts.length === 2 && out.notApplied.some(x => /already recorded/.test(x.why)));
check("a new study starts as a Concept, flagged as from a meeting", out.newStudies.length === 1 && out.newStudies[0].phase === "Concept" && out.newStudies[0].fromMeeting);
check("a study id the lab doesn't have is refused", out.notApplied.some(x => /couldn't tell which study/.test(x.why)) && !JSON.stringify(out.applied).includes("made-up-id"));
check("an unsure item is reported, not applied", st("comp").phase === "Manuscript" && out.notApplied.some(x => /held — only 20% sure/.test(x.why)));
check("a published study takes a note but nothing else", st("pub").title === "Old paper" && (st("pub").noteEntries || []).length === 1);
check("things with no home are passed through for a person", out.notApplied.some(x => /scout sequence/.test(x.text)));

console.log("\n-- A new study comes with tags (27 Oct) --");
{
  const ns = (out.newStudies || [])[0];
  check("regions land on the lab's spelling, once", ns && JSON.stringify(ns.tags.region) === JSON.stringify(["Knee"]), ns && ns.tags);
  check("topics match the list case-blind, and a new one is kept as said", ns && JSON.stringify(ns.tags.topic) === JSON.stringify(["Patellofemoral instability", "Torsion"]), ns && ns.tags);
  const v = M.tagVocabulary([{ region: ["Pelvis"], topic: ["Torsion"], hidden: ["topic|Imaging"] }]);
  check("the vocabulary is the defaults plus the lab's own, minus any it retired", v.region.includes("Pelvis") && v.topic.includes("Torsion") && !v.topic.includes("Imaging") && v.region.includes("Knee"));
  check("the model is shown the lab's tags", /TAGS — body regions: .*Pelvis/.test(M.extractPrompt("x", [], [], "2026-10-27", v)));
}

console.log("\n-- No patient ever reaches the tracker --");
const everything = JSON.stringify([S, out]);
check("the patient's name is gone from notes, evidence and everything else", !/Ladonna/i.test(everything), everything.match(/.{40}Ladonna.{20}/i));
check("redaction says what it did", /\[patient removed\]/.test(st("ipfi").noteEntries[0].text));

console.log("\n-- Every change can be reversed, and says how --");
check("every applied change carries an undo", out.applied.every(a => a.undo && a.undo.kind));
check("undo kinds cover each sort of change", ["field", "teamRemove", "milestoneRestore", "taskShelve", "noteArchive", "abstractRemove", "studyShelve"].every(k => out.applied.some(a => a.undo.kind === k)), out.applied.map(a => a.undo.kind));
check("a meeting stays up front for two days", M.MEETING_UNDO_HOURS === 48);

console.log("\n-- The reply --");
const mail = M.summaryEmail({ applied: out.applied, notApplied: out.notApplied, undoUntil: "2026-10-28T15:00:00Z", link: "https://studypipeline.com/?update=x", subject: "s", by: "Adam Yanke" });
check("groups by study and shows before → after", /MDAKP/.test(mail.text) && /Enrolled: 7 → 13/.test(mail.text));
check("held items sit under their own study, with the words behind them", (() => {
  const blk = mail.text.split("\n\n").find(b => /^COMPOSITE|^COMP/i.test(b) || b.includes("Phase: Submitted")) || "";
  return /○ Phase: Submitted — held — only 20% sure/.test(blk) && /Heard: "maybe"/.test(blk) && /✓ /.test(blk);
})(), mail.text);
check("items with no study come last", /NO STUDY MATCHED[\s\S]*scout sequence/.test(mail.text) && mail.text.lastIndexOf("NO STUDY MATCHED") > mail.text.lastIndexOf("NEW STUDIES"));
check("each applied item shows what was heard", /✓ Team: added Morgan[^\n]*\n +Heard: "you got to add Morgan on there"/.test(mail.text), mail.text);
check("links to review and undo", /\?update=x/.test(mail.html) && /Review or undo/.test(mail.html));
check("never replies to the tracker's own domain", JSON.stringify(M.threadRecipients(["Adam <adam.yanke@rushortho.com>", "studyupdates@studypipeline.com, StudyUpdates <STUDYUPDATES@studypipeline.com>"], [])) === JSON.stringify(["adam.yanke@rushortho.com"]));
check("reply-all minus the tracker's own mailbox", JSON.stringify(M.threadRecipients(["Adam Yanke <adam.yanke@rushortho.com>", "yankesportsresearch@gmail.com, Will Lee <william.lee@rushortho.com>", "adam.yanke@rushortho.com"], ["yankesportsresearch@gmail.com"])) === JSON.stringify(["adam.yanke@rushortho.com", "william.lee@rushortho.com"]));

console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
