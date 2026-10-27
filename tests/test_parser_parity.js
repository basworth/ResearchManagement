// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// The app and the server must read an email the same way.
//
// There are two copies of the matching rules, and that is a deliberate but dangerous choice: the
// app has to read a pasted email with no network, the edge function has to read a forwarded one
// with no browser. Two copies of a rule is exactly how rules drift apart while everyone assumes
// they haven't — and here the drift would be invisible, because each copy would keep passing its
// own tests.
//
// So this runs the same emails through both and fails on any disagreement. It is the only thing
// standing between "one set of rules" and "two sets of rules that used to be the same".
const fs = require("fs");
const path = require("path");

const APP = PROJECT + "/research-tracker.html";
const SERVER = PROJECT + "/supabase/functions/ingest-email/rules.ts";

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

// ---- Pull the rule block out of each file and run it in isolation ----
const appSrc = fs.readFileSync(APP, "utf8");
const START = "// Bumped whenever these rules learn something new.";
const END = "// ---------- The queue ----------";
const a = appSrc.indexOf(START), b = appSrc.indexOf(END);
if (a < 0 || b < 0) { console.error("Couldn't find the rule block in the app — the markers moved."); process.exit(1); }
const appBlock = appSrc.slice(a, b);

let serverBlock = fs.readFileSync(SERVER, "utf8");
// Strip the TypeScript that only exists to make it a module; the rules themselves are plain JS.
serverBlock = serverBlock
  .replace(/^\/\/ deno-lint-ignore-file.*$/m, "")
  .replace(/^let STUDIES: any\[\] = \[\];$/m, "")
  .replace(/^export function setStudies\(list: any\[\]\) \{ STUDIES = list \|\| \[\]; \}$/m, "")
  .replace(/\bexport function /g, "function ")
  .replace(/\bexport const /g, "const ");

function loadRules(block, wire) {
  const sandbox = { uid: () => "id", console };
  const src = `
    ${wire}
    ${block}
    return { stripPHI, matchStudyFromText, readEmail, parseLooseDate, cleanTranscript: typeof cleanTranscript === "function" ? cleanTranscript : null };
  `;
  return new Function("state", "STUDIES_IN", `
    let STUDIES = STUDIES_IN;
    ${src}
  `);
}
const appFactory = loadRules(appBlock, "");
const serverFactory = loadRules(serverBlock, "");

const STUDIES = [
  { id: "s1", title: "Meniscal repair outcomes in adolescent athletes", nickname: "Meniscus",
    irb: "ORA-24-0117", nct: "NCT04812345", journal: "AJSM", journalTrackingId: "AJSM-26-1234",
    submittedDate: "2026-08-12", decision: "Awaiting decision", revisionsDeadline: "", irbExpiry: "" },
  { id: "s2", title: "Cartilage thickness mapping study", nickname: "Cartilage", irb: "ORA-25-0042",
    journal: "", journalTrackingId: "", submittedDate: "", decision: "", revisionsDeadline: "", irbExpiry: "" },
  { id: "s3", title: "Setting Tibial Tubercle Osteotomy Expectations: Development of the STABLE Index",
    nickname: "Clustering paper STABLE", irb: "", journal: "", journalTrackingId: "",
    submittedDate: "", decision: "", revisionsDeadline: "", irbExpiry: "" },
  // Saddle Point MPFL as it stood on 26 Oct, when AJSM's .R1 receipt arrived and nothing happened.
  { id: "s4", title: "The MPFL Saddle Point: Revisiting the Radiographic landmark for femoral tunnel placement",
    nickname: "Saddle Point MPFL", irb: "", journal: "AJSM", journalTrackingId: "AJSM-26-0829",
    submittedDate: "2026-05-04", decision: "Major revision", decisionDate: "2026-09-28",
    phase: "Revisions Required", revisionsDeadline: "", irbExpiry: "" }
];
// A fresh copy each time, so one run can't contaminate the next through a mutated study.
const fresh = () => JSON.parse(JSON.stringify(STUDIES));

function run(factory, text, subject) {
  const studies = fresh();
  const api = factory({ studies }, studies);
  const r = api.readEmail(text, subject || "");
  return {
    studyId: r.study ? r.study.id : null,
    basis: r.basis,
    changes: (r.changes || []).map(c => ({ field: c.field, to: c.to, safe: c.safe })).sort((x, y) => x.field.localeCompare(y.field))
  };
}
function runPHI(factory, text) {
  const studies = fresh();
  const api = factory({ studies }, studies);
  const r = api.stripPHI(text);
  return { text: r.text, redacted: r.redacted, kinds: (r.kinds || []).slice().sort() };
}

const R1 = `From: The American Journal of Sports Medicine <onbehalfof@manuscriptcentral.com>\nDate: Monday, October 26, 2026 at 7:42 PM\nSubject: [BULK] The American Journal of Sports Medicine - Manuscript ID AJSM-26-0829.R1\n\nDear Dr. Yanke:\n\nYour revised manuscript entitled "The MPFL Saddle Point: Revisiting the Radiographic landmark for femoral tunnel placement" has been successfully submitted and is presently being given full consideration for publication in The American Journal of Sports Medicine.\n\nYour manuscript ID is AJSM-26-0829.R1. Please mention the above manuscript ID in all future correspondence.`;
// ---- The fixtures. Add a case here whenever a real email surprises us. ----
const CASES = [
  ["tracking id", `Manuscript AJSM-26-1234 has been reviewed. The reviewers recommend major revision. A revised manuscript is due by November 14, 2026.`, "Decision"],
  ["irb number", `Continuing review for ORA-25-0042: the current approval period ends March 3, 2027.`, "IRB"],
  ["nct number", `Registration NCT04812345 requires an update.`, ""],
  ["full title", `Re: Meniscal repair outcomes in adolescent athletes — decision attached.`, ""],
  ["nickname", `Quick question about the Cartilage study.`, ""],
  ["distinctive wording", `Your submission on the STABLE Index and tibial tubercle osteotomy expectations has been received by Arthroscopy: The Journal of Arthroscopic and Related Surgery.`, "Submission Confirmation"],
  ["submission confirmation, empty study", `From: Arthroscopy Journal <em@editorialmanager.com>\nDate: Tuesday, September 29, 2026 at 8:11 AM\nSubject: Submission Confirmation\n\nYour submission entitled "Cartilage thickness mapping study" has been received by Arthroscopy: The Journal of Arthroscopic and Related Surgery.`, "Submission Confirmation"],
  ["submission confirmation, moved journal", `From: Arthroscopy Journal <em@editorialmanager.com>\nDate: Tuesday, September 29, 2026 at 8:11 AM\nSubject: Submission Confirmation\n\nYour submission entitled "Meniscal repair outcomes in adolescent athletes" has been received by Arthroscopy: The Journal of Arthroscopic and Related Surgery.`, "Submission Confirmation"],
  ["accepted", `We are pleased to accept your manuscript AJSM-26-1234 for publication.`, ""],
  ["rejected", `We regret that we are unable to accept AJSM-26-1234 for publication.`, ""],
  ["minor revision", `AJSM-26-1234: minor revisions are required before acceptance.`, ""],
  ["response vs comments wording", `AJSM-26-1234. Please provide a response to reviewer comments.`, ""],
  ["ambiguous, matches nothing", `This study of patient outcomes following surgical treatment was reviewed.`, ""],
  ["unrelated", `Lunch is at noon in the conference room.`, ""],
  ["date formats", `AJSM-26-1234 revisions due by 14 Nov 2026.`, ""],
  ["us numeric date", `AJSM-26-1234 revisions due by 11/14/2026.`, ""],
  ["iso date", `AJSM-26-1234 revisions due by 2026-11-14.`, ""],
  ["revised manuscript received (.R1)", R1, "FW: [BULK] The American Journal of Sports Medicine - Manuscript ID AJSM-26-0829.R1"]
];

(async () => {
  console.log("\n-- The two copies read every fixture identically --");
  CASES.forEach(([name, text, subject]) => {
    const A = run(appFactory, text, subject);
    const B = run(serverFactory, text, subject);
    check(name, JSON.stringify(A) === JSON.stringify(B), { app: A, server: B });
  });

  console.log("\n-- A revised manuscript is a revision, not a new submission (27 Oct) --");
  {
    const r = run(appFactory, R1, "FW: [BULK] The American Journal of Sports Medicine - Manuscript ID AJSM-26-0829.R1");
    const by = Object.fromEntries(r.changes.map(c => [c.field, c]));
    check("matched to Saddle Point MPFL", r.studyId === "s4", r);
    check("decision goes back to Awaiting decision, applied on its own", by.decision && by.decision.to === "Awaiting decision" && by.decision.safe === true, r.changes);
    check("Revisions Required moves to Submitted, applied on its own", by.phase && by.phase.to === "Submitted" && by.phase.safe === true, r.changes);
    check("a note records the round and the date", by.addNote && /Revised manuscript \(R1\) submitted to AJSM on 2026-10-26/.test(by.addNote.to) && by.addNote.safe, r.changes);
    check("the original submitted date is never touched", !by.submittedDate, r.changes);
    check("nothing waits for confirmation", r.changes.every(c => c.safe), r.changes);
    const first = run(appFactory, `From: Arthroscopy Journal <em@editorialmanager.com>\nDate: Tuesday, September 29, 2026 at 8:11 AM\nSubject: Submission Confirmation\n\nYour submission entitled "Cartilage thickness mapping study" has been received by Arthroscopy: The Journal of Arthroscopic and Related Surgery.`, "Submission Confirmation");
    check("a first submission is still read as one", first.changes.some(c => c.field === "submittedDate") && !first.changes.some(c => c.field === "phase"), first.changes);
  }

  console.log("\n-- ...and strip the same things --");
  [
    ["mrn", "Patient MRN 00123456 was excluded."],
    ["ssn", "SSN 123-45-6789 appears here."],
    ["dob", "DOB: 03/14/1998 for the index case."],
    ["phone", "Call 312-555-0142 to discuss."],
    ["long number", "Reference 9876543210 in the letter."],
    ["nothing to strip", "AJSM-26-1234 was reviewed."]
  ].forEach(([name, text]) => {
    const A = runPHI(appFactory, text);
    const B = runPHI(serverFactory, text);
    check(name, JSON.stringify(A) === JSON.stringify(B), { app: A, server: B });
  });

  console.log("\n-- The server copy really is a copy, not a paraphrase --");
  {
    // Compare the two blocks with only the one sanctioned difference normalised away. Anything
    // else that differs is drift, and should have been copied across.
    const norm = (t) => t
      .replace(/state\.studies \|\| \[\]/g, "STUDIES")
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ")
      .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("//")).join("\n");
    const A = norm(appBlock);
    const B = norm(serverBlock);
    check("The rule bodies are character-for-character the same", A === B, (() => {
      if (A === B) return undefined;
      const la = A.split("\n"), lb = B.split("\n");
      for (let i = 0; i < Math.max(la.length, lb.length); i++) {
        if (la[i] !== lb[i]) return { line: i + 1, app: la[i], server: lb[i] };
      }
      return { lenApp: la.length, lenServer: lb.length };
    })());
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", (e && e.stack) ? e.stack : e); process.exit(1); });
