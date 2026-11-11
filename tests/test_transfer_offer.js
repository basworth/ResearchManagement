// Transfer (cascade) offers — 11 Nov 2026. Adam, on an Arthroscopy decision read as "Major
// revision": "this email should be interpreted as recommended cascade to open access, this is
// arthroscopy to ASMAR or AJSM to OJSM for instance, and we should track the decision from the
// journal as such and then our plan which is to deny … as well as future submission plan if
// written in the email".
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const U = "test-user-1", S = "aaaaaaaa-0000-0000-0000-0000000000a1";
const items = [
  { id: U, kind: "profile", updated_at: now, workspace: "sports-yanke", data: { id: U, name: "Adam Yanke", email: "a@b.c", position: "Clinician", admin: true, alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 999, fieldsChosen: true } },
  { id: S, kind: "study", updated_at: now, workspace: "sports-yanke", data: { id: S, title: "The Effect of Immediate Weightbearing on Distal Femoral Condyle Osteochondral Allograft Osseointegration using Computed Tomography Assessment", nickname: "OCA WBAT CT", pi: "Adam Yanke", team: [], phase: "Submitted", journal: "Arthroscopy", journalTrackingId: "ARTH-26-451", decision: "Awaiting decision", milestones: [], noteEntries: [] } },
];
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) { win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }); win.confirm = () => true; win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items }) }; } });
const w = dom.window, d = w.document;
let pass = 0, fail = 0;
const check = (n, c, x) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, x === undefined ? "" : "->" + JSON.stringify(x)), fail++);
const wait = ms => new Promise(r => setTimeout(r, ms));
const read = (text, subject) => JSON.parse(w.eval(`(function(){ var x = readEmail(${JSON.stringify(text)}, ${JSON.stringify(subject)}); return JSON.stringify({ id: x.study ? x.study.id : "", changes: x.changes }); })()`));
const EMAIL = `FYI, I would probably goto cartilage journal but please verify with Crawford and his team that they are ok with that


From: em.arth@editorialmanager.com on behalf of Arthroscopy Journal <em@editorialmanager.com>
Date: Monday, November 9, 2026 at 6:15 PM
Subject: Your Submission ARTH-26-451

The Effect of Immediate Weightbearing on Distal Femoral Condyle Osteochondral Allograft Osseointegration using Computed Tomography Assessment

Dear Dr. Yanke,

All submissions have strengths and limitations; this time, we are unable to accept your submission to Arthroscopy.  However, based on the strengths, we invite you to revise this paper for publication in Arthroscopy, Sports Medicine, and Rehabilitation (ASMAR). Note that because you originally submitted for consideration for publication in Arthroscopy, we need to inform you that our decision is final.

ASMAR is indexed in PubMed Central. The reviewers asked for major revisions before it could be considered there.`;
(async () => {
  await wait(700); w.eval("syncOnline = true;");
  console.log("\n-- The Arthroscopy → ASMAR email, forwarded with a note --");
  const r = read(EMAIL, "FW: Your Submission ARTH-26-451");
  const by = (f) => r.changes.find(c => c.field === f);
  check("matched to the study", r.id === S);
  check("decision is Transfer offered, not Major revision", by("decision") && by("decision").to === "Transfer offered", r.changes);
  check("...and never applies itself", by("decision") && !by("decision").safe);
  check("offered to ASMAR", by("transferTo") && by("transferTo").to === "ASMAR");
  check("our plan: decline (the note names another journal)", by("transferPlan") && by("transferPlan").to === "Decline transfer" && by("transferPlan").safe);
  check("next journal: Cartilage", by("nextJournal") && by("nextJournal").to === "Cartilage", by("nextJournal"));
  check("the note is kept on the study", by("addNote") && /verify with Crawford/.test(by("addNote").to));

  console.log("\n-- No note: decline is offered, unticked --");
  const r2 = read(EMAIL.replace(/^FYI[^\n]*\n/, ""), "Your Submission ARTH-26-451");
  const p2 = r2.changes.find(c => c.field === "transferPlan");
  check("plan offered as Decline transfer, waiting for a person", p2 && p2.to === "Decline transfer" && !p2.safe, r2.changes);
  check("no next journal invented", !r2.changes.find(c => c.field === "nextJournal"));

  console.log("\n-- AJSM → OJSM wording --");
  const r3 = read("Ref ARTH-26-451. We regret that we cannot accept your manuscript for AJSM. The editors recommend it for transfer to The Orthopaedic Journal of Sports Medicine (OJSM), our open access journal.", "Decision");
  check("offered to OJSM", (r3.changes.find(c => c.field === "transferTo") || {}).to === "OJSM", r3.changes);

  console.log("\n-- A plain rejection is still a rejection --");
  const r4 = read("Ref ARTH-26-451. We regret to inform you that your manuscript has been rejected.", "Decision");
  check("Rejected, no transfer", (r4.changes.find(c => c.field === "decision") || {}).to === "Rejected" && !r4.changes.find(c => c.field === "transferTo"), r4.changes);

  console.log("\n-- Applying, the study page, filing the round away --");
  w.eval(`(function(){ var s = studyById("${S}"); var x = readEmail(${JSON.stringify(EMAIL)}, "FW"); x.changes.forEach(function(c){ applyChange(s, c); }); upsertStudy(s); })()`);
  const s = JSON.parse(w.eval(`JSON.stringify(studyById("${S}"))`));
  check("study records the offer, plan and next journal", s.decision === "Transfer offered" && s.transferTo === "ASMAR" && s.transferPlan === "Decline transfer" && s.nextJournal === "Cartilage", s);
  w.eval(`openStudy("${S}"); tab = "studies"; render()`); await wait(80);
  check("manuscript section shows the transfer card", !!d.getElementById("ms-transfer-plan") && d.getElementById("ms-transfer-plan").value === "Decline transfer");
  check("...and the next-journal plan", d.getElementById("ms-next-journal") && d.getElementById("ms-next-journal").value === "Cartilage");
  const btn = d.getElementById("ms-resubmit");
  check("file-away button is there", !!btn);
  if (btn) btn.onclick(); await wait(50);
  const s2 = JSON.parse(w.eval(`JSON.stringify(studyById("${S}"))`));
  const last = (s2.priorSubmissions || []).slice(-1)[0] || {};
  check("filed round keeps the offer and our answer", last.journal === "Arthroscopy" && last.decision === "Transfer offered" && last.transferTo === "ASMAR" && last.transferPlan === "Decline transfer", last);
  check("next journal plan survives filing away", s2.nextJournal === "Cartilage" && !s2.journal && !s2.transferTo);
  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
