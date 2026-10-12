// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Suggested Updates: reading a journal or IRB email and proposing the change.
//
// The value is obvious — the email already says what happened, so nobody should retype it. The
// danger is equally obvious: a parser reading free text will sometimes be wrong, and a wrong edit
// to a study record is worse than no edit at all. So almost everything here is about restraint —
// what it refuses to do on its own, what it says it did, and what it keeps.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ME = "11111111-1111-1111-1111-111111111111";
const S1 = "aaaaaaaa-0000-0000-0000-000000000001";
const S2 = "aaaaaaaa-0000-0000-0000-000000000002";

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

function boot(studyExtra) {
  const items = [
    { id: ME, kind: "profile", updated_at: now,
      data: { id: ME, name: "Adam Yanke", email: "adam.yanke@rushortho.com", position: "Clinician",
              admin: true, reportsTo: "", alertEmail: "", linkedTo: "", alertEmailAsked: true, degreesAsked: true } },
    { id: S1, kind: "study", updated_at: now,
      data: Object.assign({ id: S1, title: "Meniscal repair outcomes in adolescent athletes",
        nickname: "Meniscus", phase: "Submitted", design: "Retrospective (Non-Consented)",
        irb: "ORA-24-0117", nct: "NCT04812345", journal: "AJSM", journalTrackingId: "AJSM-26-1234",
        submittedDate: "2026-08-12", decision: "Awaiting decision", revisionsDeadline: "",
        irbExpiry: "", pi: "Adam Yanke", team: [], abstracts: [], docs: [], milestones: [],
        meetingNotes: [], authors: [] }, studyExtra || {}) },
    { id: S2, kind: "study", updated_at: now,
      data: { id: S2, title: "Cartilage thickness mapping", nickname: "Cartilage", phase: "Analysis",
        design: "Basic Science", irb: "ORA-25-0042", pi: "Adam Yanke", team: [], abstracts: [],
        docs: [], milestones: [], meetingNotes: [], authors: [], decision: "" } },
    { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
      data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} } }
  ];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, pending: [], active: [] }) });
      win.supabase = { createClient: () => {
        const c = makeMockSupabase({ items });
        c.auth.getSession = async () => ({ data: { session: { access_token: "tok", user: { id: ME, email: "adam.yanke@rushortho.com" } } }, error: null });
        return c;
      } };
    }
  });
  return dom;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

async function settings(dom) {
  const { window } = dom;
  await wait(600);
  window.eval(`currentUser = { id: ${JSON.stringify(ME)}, email: "adam.yanke@rushortho.com" }; syncOnline = true;`);
  window.document.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
  await wait(60);
  window.eval(`tab = "settings"; render();`);
  await wait(350);
  return window;
}
const study = (win, id) => JSON.parse(win.eval(`JSON.stringify(studyById(${JSON.stringify(id || S1)}))`));
const suggestions = (win) => JSON.parse(win.eval("JSON.stringify(state.suggestions || [])"));
const read = (win, text, subject) => JSON.parse(win.eval(`JSON.stringify(readEmail(${JSON.stringify(text)}, ${JSON.stringify(subject || "")}))`));
const mainText = (win) => win.document.getElementById("main").textContent;
const toastText = (win) => win.document.getElementById("toast").textContent;

const REVISION_EMAIL = `Dear Dr Yanke,

Manuscript AJSM-26-1234, "Meniscal repair outcomes in adolescent athletes", has been reviewed.
The reviewers recommend major revision. A revised manuscript is due by November 14, 2026.

American Journal of Sports Medicine`;

(async () => {
  console.log("\n-- Working out which study an email is about --");
  {
    const dom = boot();
    const win = await settings(dom);
    check("A journal tracking ID identifies it", read(win, REVISION_EMAIL).study.id === S1);
    check("...and says so, so the match can be checked", /AJSM-26-1234/.test(read(win, REVISION_EMAIL).basis),
      read(win, REVISION_EMAIL).basis);
    check("An IRB number works too", read(win, "Your study ORA-25-0042 was reviewed.").study.id === S2);
    check("So does an NCT number", read(win, "Registration NCT04812345 requires an update.").study.id === S1);
    check("So does the full title", read(win, "Re: Meniscal repair outcomes in adolescent athletes").study.id === S1);
    check("An unrelated email matches nothing", read(win, "Lunch is at noon in the conference room.").study === null);
    check("A number that is nobody's IRB matches nothing", read(win, "Study ORA-99-9999 was reviewed.").study === null);
    dom.window.close();
  }

  console.log("\n-- A tracking ID beats a nickname, because it's unambiguous --");
  {
    const dom = boot();
    const win = await settings(dom);
    // "Cartilage" is S2's nickname, but the tracking ID belongs to S1.
    const r = read(win, "AJSM-26-1234 — reviewers note the cartilage findings need more detail.");
    check("The specific identifier wins", r.study.id === S1, r.basis);
    check("...and the basis names it", /tracking ID/.test(r.basis), r.basis);
    dom.window.close();
  }

  console.log("\n-- Reading a revision decision --");
  {
    const dom = boot();
    const win = await settings(dom);
    const r = read(win, REVISION_EMAIL);
    const dec = r.changes.find(c => c.field === "decision");
    check("It spots the major revision", dec && dec.to === "Major revision", r.changes);
    check("A decision is NEVER applied on its own", dec && dec.safe === false);
    const due = r.changes.find(c => c.field === "revisionsDeadline");
    check("It reads the due date", due && due.to === "2026-11-14", due);
    check("...and that IS safe, because the field was empty", due && due.safe === true);
    dom.window.close();
  }

  console.log("\n-- It never overwrites something a person typed --");
  {
    const dom = boot({ revisionsDeadline: "2026-11-01" });
    const win = await settings(dom);
    const due = read(win, REVISION_EMAIL).changes.find(c => c.field === "revisionsDeadline");
    check("A conflicting date is proposed, not applied", due && due.safe === false, due);
    check("...showing both values so you can judge", /2026-11-14[\s\S]*2026-11-01|2026-11-01[\s\S]*2026-11-14/.test(due.why), due.why);
    dom.window.close();
  }

  console.log("\n-- The safe change really does apply itself --");
  {
    const dom = boot();
    const win = await settings(dom);
    win.eval(`ingestEmail(${JSON.stringify(REVISION_EMAIL)}, "Decision on AJSM-26-1234", "paste", "journal@ajsm.org")`);
    await wait(250);
    check("The due date is on the study", study(win).revisionsDeadline === "2026-11-14", study(win).revisionsDeadline);
    check("The decision was NOT changed", study(win).decision === "Awaiting decision", study(win).decision);
    const g = suggestions(win)[0];
    check("It's still waiting on the decision", g.status === "pending" && g.changes.length === 1, g);
    // Just the deadline now: the email was understood, so no note is made alongside it.
    check("...and records what it already did",
      g.applied.some(a => a.field === "revisionsDeadline") && !g.applied.some(a => a.field === "addNote"), g.applied);
    check("...including that the field was empty before",
      g.applied.find(a => a.field === "revisionsDeadline").from === "", g.applied);
    dom.window.close();
  }

  console.log("\n-- Accepting the rest --");
  {
    const dom = boot();
    const win = await settings(dom);
    win.eval(`ingestEmail(${JSON.stringify(REVISION_EMAIL)}, "Decision", "paste", ""); render();`);
    await wait(250);
    const id = suggestions(win)[0].id;
    win.eval(`acceptSuggestion(${JSON.stringify(id)}, ["decision"])`);
    await wait(250);
    check("The decision is now set", study(win).decision === "Major revision", study(win).decision);
    check("...and dated, as it would be by hand", !!study(win).decisionDate, study(win).decisionDate);
    check("The phase was NOT moved by an email", study(win).phase === "Submitted", study(win).phase);
    const g = suggestions(win)[0];
    check("Nothing is left to decide", g.changes.length === 0);
    check("...so it's filed as applied", g.status === "applied");
    check("...with who did it", g.decidedBy === "Adam Yanke", g.decidedBy);
    dom.window.close();
  }

  console.log("\n-- Dismissing keeps the record --");
  {
    const dom = boot();
    const win = await settings(dom);
    win.eval(`ingestEmail(${JSON.stringify(REVISION_EMAIL)}, "Decision", "paste", ""); render();`);
    await wait(250);
    const id = suggestions(win)[0].id;
    win.eval(`dismissSuggestion(${JSON.stringify(id)})`);
    await wait(250);
    const g = suggestions(win)[0];
    check("It's marked dismissed, not deleted", g.status === "dismissed" && suggestions(win).length === 1);
    check("The email text is still there", /major revision/i.test(g.text));
    check("So is what it had proposed", g.changes.length === 1, g.changes);
    check("The study is untouched", study(win).decision === "Awaiting decision");
    check("It says nothing was changed", /nothing was changed/i.test(toastText(win)), toastText(win));
    dom.window.close();
  }

  console.log("\n-- Patient data is stripped before anything is stored --");
  {
    const dom = boot();
    const win = await settings(dom);
    const dirty = `Re AJSM-26-1234. Patient MRN 00123456 (DOB: 03/14/1998), SSN 123-45-6789, call 312-555-0142.`;
    win.eval(`ingestEmail(${JSON.stringify(dirty)}, "Query", "paste", "")`);
    await wait(250);
    const g = suggestions(win)[0];
    check("No MRN stored", !/00123456/.test(g.text), g.text);
    check("No SSN stored", !/123-45-6789/.test(g.text), g.text);
    check("No date of birth stored", !/03\/14\/1998/.test(g.text), g.text);
    check("No phone number stored", !/312-555-0142/.test(g.text), g.text);
    check("It counts what it removed", g.redacted >= 4, g.redacted);
    check("...and says what kinds", (g.redactedKinds || []).length > 0, g.redactedKinds);
    check("The tracking ID survives, or the email would be unmatchable", /AJSM-26-1234/.test(g.text), g.text);
    check("...and it still matched the study", g.studyId === S1);
    dom.window.close();
  }

  console.log("\n-- An email it can't place changes nothing --");
  {
    const dom = boot();
    const win = await settings(dom);
    win.eval(`ingestEmail("The reviewers recommend major revision.", "Decision", "paste", ""); render();`);
    await wait(250);
    const g = suggestions(win)[0];
    check("No study attached", !g.studyId);
    check("No changes proposed", g.changes.length === 0 && g.applied.length === 0);
    check("It's still kept, so it isn't silently dropped", g.status === "pending");
    check("...and says why on screen", /Couldn't tell which study/i.test(mainText(win)), mainText(win).slice(0, 200));
    check("No study got a decision", study(win).decision === "Awaiting decision" && study(win, S2).decision === "");
    dom.window.close();
  }

  console.log("\n-- Pasting one in through the screen --");
  {
    const dom = boot();
    const win = await settings(dom);
    const doc = win.document;
    check("There's somewhere to paste", !!doc.getElementById("sugg-body"));
    doc.getElementById("sugg-subject").value = "Decision on AJSM-26-1234";
    doc.getElementById("sugg-body").value = REVISION_EMAIL;
    doc.getElementById("sugg-add").click();
    await wait(400);
    check("It read it", suggestions(win).length === 1);
    check("The boxes are cleared for the next one", win.document.getElementById("sugg-body").value === "",
      win.document.getElementById("sugg-body").value);
    const t = mainText(win);
    check("The card names the study it matched", /Meniscus/.test(t), t.slice(0, 400));
    check("...and how it matched", /tracking ID/.test(t));
    check("...what it already applied", /ALREADY APPLIED/.test(t));
    check("...and what it's waiting on", /NEEDS YOUR DECISION/.test(t));
    dom.window.close();
  }

  console.log("\n-- Pasting nothing is refused --");
  {
    const dom = boot();
    const win = await settings(dom);
    win.document.getElementById("sugg-add").click();
    await wait(250);
    check("Nothing was created", suggestions(win).length === 0);
    check("...and it says what to do", /Paste the email first/i.test(toastText(win)), toastText(win));
    dom.window.close();
  }

  console.log("\n-- Reading the decision wording --");
  {
    const dom = boot();
    const win = await settings(dom);
    const cases = [
      ["We are pleased to accept your manuscript AJSM-26-1234.", "Accepted"],
      ["We regret that we are unable to accept AJSM-26-1234 for publication.", "Rejected"],
      ["AJSM-26-1234: minor revisions are required before acceptance.", "Minor revision"],
      ["AJSM-26-1234 requires major revision prior to further consideration.", "Major revision"]
    ];
    cases.forEach(([text, want]) => {
      const c = read(win, text).changes.find(x => x.field === "decision");
      check(`"${text.slice(0, 40)}…" → ${want}`, c && c.to === want, c);
    });
    // Nothing decision-shaped at all.
    check("A submission acknowledgement proposes no decision",
      !read(win, "AJSM-26-1234 has been received and assigned to an editor.").changes.some(c => c.field === "decision"));
    dom.window.close();
  }

  console.log("\n-- Dates in the shapes these emails actually use --");
  {
    const dom = boot();
    const win = await settings(dom);
    const p = (str) => win.eval(`parseLooseDate(${JSON.stringify(str)})`);
    check("November 14, 2026", p("November 14, 2026") === "2026-11-14");
    check("14 Nov 2026", p("14 Nov 2026") === "2026-11-14");
    check("2026-11-14", p("2026-11-14") === "2026-11-14");
    check("11/14/2026 read US-style", p("11/14/2026") === "2026-11-14");
    check("Nothing date-shaped gives nothing", p("sometime next month") === "");
    dom.window.close();
  }

  console.log("\n-- An IRB expiry email --");
  {
    const dom = boot();
    const win = await settings(dom);
    win.eval(`ingestEmail("Continuing review for ORA-24-0117: the current approval period ends March 3, 2027.", "IRB", "paste", "")`);
    await wait(250);
    check("The expiry is filled in, because it was empty", study(win).irbExpiry === "2027-03-03", study(win).irbExpiry);
    dom.window.close();
  }
  {
    const dom = boot({ irbExpiry: "2027-01-01" });
    const win = await settings(dom);
    win.eval(`ingestEmail("Continuing review for ORA-24-0117: approval period ends March 3, 2027.", "IRB", "paste", ""); render();`);
    await wait(250);
    check("An existing expiry is never overwritten", study(win).irbExpiry === "2027-01-01", study(win).irbExpiry);
    check("...it's queued for a decision instead", suggestions(win)[0].changes.some(c => c.field === "irbExpiry"));
    dom.window.close();
  }

  console.log("\n-- A conference acceptance is a submission record, not a note --");
  {
    const AAOS = `From: AAOS <noreply@aaos.org>
Date: Thursday, October 1, 2026 at 7:30 AM
Subject: FW: [BULK] AAOS 2027 Annual Meeting Paper Presentation Information

Congratulations. Your abstract "Meniscal repair outcomes in adolescent athletes" has been accepted for presentation at the AAOS 2027 Annual Meeting as a paper presentation.`;
    const dom = boot({ abstracts: [] });
    const win = await settings(dom);
    const r = read(win, AAOS, "FW: [BULK] AAOS 2027 Annual Meeting Paper Presentation Information");
    const abs = r.changes.find(c => c.field === "abstractSubmission");
    check("It reads it as an abstract submission", !!abs, r.changes);
    check("...naming the meeting", /AAOS 2027/.test(abs.to), abs.to);
    check("...as accepted", /Accepted/.test(abs.to), abs.to);
    check("...for a podium, since 'paper presentation' means a talk", /Podium/.test(abs.to), abs.to);
    check("No note is made, because the email WAS understood",
      !r.changes.some(c => c.field === "addNote"), r.changes);

    win.eval(`ingestEmail(${JSON.stringify(AAOS)}, "FW: [BULK] AAOS 2027 Annual Meeting Paper Presentation Information", "paste", ""); render();`);
    await wait(300);
    const a = study(win).abstracts;
    check("The submission is on the study", a.length === 1, a);
    check("...with the meeting", a[0].meeting === "AAOS 2027", a[0]);
    check("...accepted as a podium", a[0].status === "Accepted" && a[0].format === "Podium", a[0]);
    check("...and no note was added", (study(win).noteEntries || []).length === 0, study(win).noteEntries);
    dom.window.close();
  }

  console.log("\n-- A poster is not a podium, and a rejection is not an acceptance --");
  {
    const dom = boot({ abstracts: [] });
    const win = await settings(dom);
    const poster = read(win, `AJSM-26-1234. Your abstract has been accepted for presentation at the AOSSM 2027 Annual Meeting as a poster.`, "");
    check("A poster is recorded as a poster",
      /Poster/.test(poster.changes.find(c => c.field === "abstractSubmission").to),
      poster.changes);
    // The worst available mistake: reading a rejection as an acceptance.
    const no = read(win, `AJSM-26-1234. We regret that your abstract was not accepted for the AAOS 2027 Annual Meeting.`, "");
    const r2 = no.changes.find(c => c.field === "abstractSubmission");
    check("A rejection is a rejection", r2 && /Rejected/.test(r2.to), no.changes);
    check("...and definitely not accepted", r2 && !/Accepted/.test(r2.to), r2);
    dom.window.close();
  }

  console.log("\n-- An existing submission is updated, never duplicated --");
  {
    const dom = boot({ abstracts: [{ id: "a1", meeting: "AAOS 2027", date: "2026-06-01", status: "Submitted" }] });
    const win = await settings(dom);
    const r = read(win, `AJSM-26-1234 accepted for presentation at the AAOS 2027 Annual Meeting as a paper presentation.`, "");
    const abs = r.changes.find(c => c.field === "abstractSubmission");
    check("Changing a recorded status is never automatic", abs.safe === false, abs);
    check("...showing what the study currently says", /Submitted/.test(abs.why), abs.why);
    win.eval(`ingestEmail("AJSM-26-1234 accepted for presentation at the AAOS 2027 Annual Meeting as a paper presentation.", "", "paste", ""); render();`);
    await wait(300);
    const g = suggestions(win)[0];
    win.eval(`acceptSuggestion(${JSON.stringify(g.id)}, ["abstractSubmission"]);`);
    await wait(300);
    const a = study(win).abstracts;
    check("Still one entry, not two", a.length === 1, a);
    check("...keeping its original id and date", a[0].id === "a1" && a[0].date === "2026-06-01", a[0]);
    check("...now accepted as a podium", a[0].status === "Accepted" && a[0].format === "Podium", a[0]);
    dom.window.close();
  }

  console.log("\n-- Notes are a fallback, not a default --");
  {
    const dom = boot({ journal: "", submittedDate: "", decision: "" });
    const win = await settings(dom);
    // A decision: understood, so no note.
    const dec = read(win, "AJSM-26-1234: the reviewers recommend major revision.", "");
    check("A decision email makes no note", !dec.changes.some(c => c.field === "addNote"), dec.changes);
    // Prose with nothing structured in it: kept as a note, which is the whole point.
    const prose = read(win, "AJSM-26-1234 — Amy sent the quote for the sheep procedures, it's in the shared folder.", "");
    check("An email with nothing to file still becomes a note",
      prose.changes.some(c => c.field === "addNote"), prose.changes);
    check("...and says why it's a note", /nothing in it maps to a field/.test(prose.changes.find(c => c.field === "addNote").why));
    dom.window.close();
  }

  console.log("\n-- A forwarded email becomes a note on the study --");
  {
    const UPDATE = `From: Carla Edwards <carla.edwards@rushortho.com>
Date: Wednesday, October 1, 2026 at 9:02 AM
To: Adam Yanke <adam.yanke@rushortho.com>
Subject: FW: Meniscal repair outcomes - pilot updates

Rush Email Security
This email originated from outside of RUSH. Do not click links or attachments unless you recognize the sender.

AJSM-26-1234 — Amy sent the quote for the sheep procedures, it's in the shared folder. Post-op care isn't included.

Thanks,
Carla Edwards
Research Coordinator
Midwest Orthopaedics at Rush
CONFIDENTIALITY: This e-mail and any attachments are intended only for the addressee.
> On Tuesday someone wrote the thing we are replying to`;
    const dom = boot();
    const win = await settings(dom);
    const r = read(win, UPDATE, "FW: Meniscal repair outcomes - pilot updates");
    const note = r.changes.find(c => c.field === "addNote");
    check("It offers a note", !!note, r.changes);
    check("...applied by itself, since a note destroys nothing", note.safe === true);
    check("...keeping what Carla actually wrote", /Amy sent the quote/.test(note.to), note.to);
    check("...headed with the subject", /Meniscal repair outcomes - pilot updates/.test(note.to));
    check("...without the FW: prefix", !/^FW:/.test(note.to), note.to.slice(0, 40));
    check("The security banner is gone", !/Email Security|originated from outside/.test(note.to), note.to);
    check("The signature is gone", !/Research Coordinator/.test(note.to), note.to);
    check("The confidentiality footer is gone", !/CONFIDENTIALITY/.test(note.to), note.to);
    check("The quoted reply underneath is gone", !/we are replying to/.test(note.to), note.to);
    check("The forwarded headers are gone", !/carla\.edwards@rushortho\.com/.test(note.to), note.to);

    // And it really lands on the study.
    win.eval(`ingestEmail(${JSON.stringify(UPDATE)}, "FW: Meniscal repair outcomes - pilot updates", "paste", ""); render();`);
    await wait(300);
    const notes = JSON.parse(win.eval(`JSON.stringify(studyById(${JSON.stringify(S1)}).noteEntries || [])`));
    check("A note was added to the study", notes.length === 1, notes);
    check("...dated today", notes[0].date === win.eval("todayStr()"));
    check("...and live, not archived", notes[0].archivedOn === "");
    dom.window.close();
  }

  console.log("\n-- Notes are appended, never overwritten --");
  {
    const dom = boot({ noteEntries: [{ id: "old", text: "Something already here", date: "2026-09-01", archivedOn: "" }] });
    const win = await settings(dom);
    win.eval(`ingestEmail("AJSM-26-1234 — quick update from the lab.", "Lab update", "paste", ""); render();`);
    await wait(300);
    const notes = JSON.parse(win.eval(`JSON.stringify(studyById(${JSON.stringify(S1)}).noteEntries || [])`));
    check("The existing note survives", notes.some(n => n.id === "old"), notes);
    check("...and the new one is added alongside", notes.length === 2, notes.length);
    dom.window.close();
  }

  console.log("\n-- An email with nothing but noise makes no note --");
  {
    const dom = boot();
    const win = await settings(dom);
    const r = read(win, `From: Carla <carla.edwards@rushortho.com>\nSubject: AJSM-26-1234\n\nRush Email Security\nThis email originated from outside of RUSH.\n\nThanks,\nCarla`, "AJSM-26-1234");
    const note = r.changes.find(c => c.field === "addNote");
    // The subject carries the tracking ID so the study matches, but there's no actual message.
    check("No note is proposed from a banner and a signature", !note || !/originated from outside/.test(note.to), note);
    dom.window.close();
  }

  console.log("\n-- A better parser re-reads what an older one missed --");
  {
    const CONFIRM = `From: Arthroscopy Journal <em@editorialmanager.com>
Date: Tuesday, September 29, 2026 at 8:11 AM
Subject: Submission Confirmation

Your submission entitled "Meniscal repair outcomes in adolescent athletes" has been received by Arthroscopy: The Journal of Arthroscopic and Related Surgery.`;
    const dom = boot({ journal: "", submittedDate: "", decision: "" });
    const win = await settings(dom);
    // Exactly what happened to the first real Arthroscopy email: read by an older parser that
    // didn't understand submission confirmations, so filed as "read, nothing found" for good.
    win.eval(`state.suggestions.push({
      id: "old1", createdAt: new Date().toISOString(), source: "email",
      from: "adam.yanke@rushortho.com", subject: "FW: Submission Confirmation",
      text: ${JSON.stringify(CONFIRM)}, redacted: 0, redactedKinds: [],
      forwardedBy: ${JSON.stringify(ME)}, forwardedByName: "Adam Yanke", unverified: false,
      studyId: "", basis: "", changes: [], applied: [], status: "pending",
      needsParse: false, parserVersion: 1
    });`);
    check("It starts with nothing found", suggestions(win).find(g => g.id === "old1").changes.length === 0);
    win.eval("parseIncomingSuggestions(); render();");
    await wait(300);
    const g = suggestions(win).find(x => x.id === "old1");
    check("The newer parser picks it up again", g.changes.length > 0 || g.applied.length > 0, g);
    check("...matching the study this time", g.studyId === S1, g.studyId);
    check("...and stamping the version that read it", g.parserVersion === win.eval("PARSER_VERSION"), g.parserVersion);
    check("The journal was filled in", study(win).journal === "Arthroscopy", study(win).journal);
    dom.window.close();
  }

  console.log("\n-- ...but never re-reads something a person already decided --");
  {
    const dom = boot();
    const win = await settings(dom);
    win.eval(`state.suggestions.push({
      id: "done1", createdAt: new Date().toISOString(), source: "email", from: "", subject: "Old decision",
      text: "AJSM-26-1234: minor revisions are required.", redacted: 0, redactedKinds: [],
      forwardedBy: ${JSON.stringify(ME)}, forwardedByName: "Adam Yanke", unverified: false,
      studyId: ${JSON.stringify(S1)}, basis: "tracking ID", changes: [], applied: [],
      status: "dismissed", decidedBy: "Adam Yanke", needsParse: false, parserVersion: 1
    });`);
    win.eval("parseIncomingSuggestions(); render();");
    await wait(300);
    const g = suggestions(win).find(x => x.id === "done1");
    check("A dismissed item stays dismissed", g.status === "dismissed");
    check("...and gains no new proposals", g.changes.length === 0, g.changes);
    check("The study was not touched", study(win).decision === "Awaiting decision", study(win).decision);
    dom.window.close();
  }

  console.log("\n-- A submission confirmation --");
  {
    const CONFIRM = `From: Arthroscopy Journal <em@editorialmanager.com>
Date: Tuesday, September 29, 2026 at 8:11 AM
To: Adam Yanke <adam.yanke@rushortho.com>
Subject: Submission Confirmation

Dear Dr. Yanke,
Your submission entitled "Meniscal repair outcomes in adolescent athletes" has been received by Arthroscopy: The Journal of Arthroscopic and Related Surgery.`;
    // A study with nothing recorded yet: the confirmation should fill it in.
    const dom = boot({ journal: "", submittedDate: "", decision: "", journalTrackingId: "" });
    const win = await settings(dom);
    const r = read(win, CONFIRM, "Submission Confirmation");
    check("It matched the study", r.study && r.study.id === S1, r.basis);
    const j = r.changes.find(c => c.field === "journal");
    check("It reads the journal", j && j.to === "Arthroscopy", r.changes);
    check("...trimming the journal's own subtitle", j && !/Journal of Arthroscopic/.test(j.to), j);
    check("...and fills an empty field, so it applies itself", j && j.safe === true);
    const d = r.changes.find(c => c.field === "submittedDate");
    check("It reads the date the confirmation was sent", d && d.to === "2026-09-29", r.changes);
    const dec = r.changes.find(c => c.field === "decision");
    check("...and sets it awaiting a decision", dec && dec.to === "Awaiting decision");
    check("It is NOT read as a decision", !r.changes.some(c => c.field === "decision" && c.to !== "Awaiting decision"));
    dom.window.close();
  }

  console.log("\n-- Submitted somewhere new after a rejection --");
  {
    const CONFIRM = `From: Arthroscopy Journal <em@editorialmanager.com>
Date: Tuesday, September 29, 2026 at 8:11 AM
Subject: Submission Confirmation

Your submission entitled "Meniscal repair outcomes in adolescent athletes" has been received by Arthroscopy: The Journal of Arthroscopic and Related Surgery.`;
    // The real case: rejected at AJSM, now submitted to Arthroscopy.
    const dom = boot({ journal: "AJSM", submittedDate: "2026-08-12", decision: "Rejected", journalTrackingId: "AJSM-26-1234" });
    const win = await settings(dom);
    const r = read(win, CONFIRM, "Submission Confirmation");
    const mv = r.changes.find(c => c.field === "newSubmission");
    check("It spots that the paper has moved journal", !!mv, r.changes);
    check("...naming the new one", /Arthroscopy/.test(mv.to), mv);
    check("...and is never applied automatically", mv.safe === false);
    check("...explaining what it would do to the old round", /Previous Submissions/.test(mv.why), mv.why);
    check("It does NOT quietly overwrite the journal field", !r.changes.some(c => c.field === "journal"), r.changes);

    // Accepting it should do the same bookkeeping as the "File this away" button.
    win.eval(`ingestEmail(${JSON.stringify(CONFIRM)}, "Submission Confirmation", "paste", ""); render();`);
    await wait(300);
    const g = suggestions(win)[0];
    win.eval(`acceptSuggestion(${JSON.stringify(g.id)}, ["newSubmission"]);`);
    await wait(300);
    const st = study(win);
    check("The new journal is recorded", st.journal === "Arthroscopy", st.journal);
    check("...with the new submission date", st.submittedDate === "2026-09-29", st.submittedDate);
    check("...awaiting a decision again", st.decision === "Awaiting decision", st.decision);
    check("The old tracking ID is cleared, since it belonged to AJSM", st.journalTrackingId === "", st.journalTrackingId);
    check("The AJSM round was filed, not deleted", st.priorSubmissions.length === 1, st.priorSubmissions);
    check("...keeping its journal", st.priorSubmissions[0].journal === "AJSM");
    check("...its decision", st.priorSubmissions[0].decision === "Rejected");
    check("...and its dates", st.priorSubmissions[0].submittedDate === "2026-08-12");
    dom.window.close();
  }

  console.log("\n-- The study itself says something is waiting --");
  {
    const dom = boot({ journal: "", submittedDate: "", decision: "" });
    const win = await settings(dom);
    win.eval(`ingestEmail("Reviewers recommend major revision for AJSM-26-1234.", "Decision", "paste", "");`);
    await wait(200);
    win.eval(`tab = "studies"; openStudy(${JSON.stringify(S1)}); render();`);
    await wait(300);
    const t = win.document.getElementById("main").textContent;
    check("The study page says there's something to review", /suggested update/i.test(t), t.slice(0, 500));
    check("...and that nothing has been changed yet", /NOTHING CHANGED YET/i.test(t));
    // The whole card, on the study — not a link to Settings.
    check("The proposal is right there, tickable", !!win.document.querySelector(".sugg-pick"));
    check("...with its Apply button", !!win.document.querySelector("[data-sugg-accept]"));
    check("...and Dismiss", !!win.document.querySelector("[data-sugg-dismiss]"));
    dom.window.close();
  }

  console.log("\n-- Matching on distinctive words when the title has been edited --");
  {
    const dom = boot();
    const win = await settings(dom);
    // A real case: the journal's confirmation carries the title, but by the time a decision comes
    // back the title has been reworded. "Meniscal" and "adolescent" still point to one study.
    const r = read(win, "Your submission on meniscal repair in adolescent athletes has been received.");
    check("It still finds the study", r.study && r.study.id === S1, r.basis);
    check("...and says it matched on wording", /wording/.test(r.basis), r.basis);
    check("...naming the words, so a wrong match is obvious", /meniscal|adolescent/.test(r.basis), r.basis);
    dom.window.close();
  }

  console.log("\n-- Common words identify nothing --");
  {
    const dom = boot();
    const win = await settings(dom);
    check("A sentence of orthopaedic boilerplate matches nothing",
      read(win, "This study of patient outcomes following surgical treatment was reviewed.").study === null,
      read(win, "This study of patient outcomes following surgical treatment was reviewed.").basis);
    // "cartilage" is a study NICKNAME, and matching a nickname is deliberate — it's the handle
    // people actually use. So test a word that is merely present in a title.
    check("A single ordinary title word isn't enough on its own",
      read(win, "We discussed the mapping briefly.").study === null,
      read(win, "We discussed the mapping briefly.").basis);
    dom.window.close();
  }

  console.log("\n-- Too close to call means no guess --");
  {
    const dom = boot();
    const win = await settings(dom);
    // Two studies added that differ by one word, then text that fits both equally.
    win.eval(`
      state.studies.push({ id: "t1", title: "Chondral lesion morphology of the patella", nickname: "Patella morphology", team: [], abstracts: [], docs: [], milestones: [], meetingNotes: [], authors: [], noteEntries: [] });
      state.studies.push({ id: "t2", title: "Chondral lesion morphology of the trochlea", nickname: "Trochlea morphology", team: [], abstracts: [], docs: [], milestones: [], meetingNotes: [], authors: [], noteEntries: [] });
    `);
    const r = read(win, "Regarding the chondral lesion morphology work, please respond.");
    check("It declines to pick between two near-identical studies", r.study === null, r.basis);
    // ...but the distinguishing word settles it.
    const r2 = read(win, "Regarding the chondral lesion morphology in the trochlea, please respond.");
    check("Adding the word that separates them resolves it", r2.study && r2.study.id === "t2", r2.basis);
    dom.window.close();
  }

  console.log("\n-- An identifier still beats wording --");
  {
    const dom = boot();
    const win = await settings(dom);
    // Cartilage words everywhere, but the meniscus study's tracking ID is present.
    const r = read(win, "AJSM-26-1234: the cartilage thickness mapping section needs work.");
    check("The tracking ID wins", r.study.id === S1, r.basis);
    check("...and the basis says so, not 'wording'", /tracking ID/.test(r.basis), r.basis);
    dom.window.close();
  }

  console.log("\n-- A forward is attributed to whoever sent it --");
  {
    const dom = boot();
    const win = await settings(dom);
    // Carla's profile exists, so a forward from her address is hers.
    win.eval(`state.profiles.push({ id: "carla", name: "Carla Edwards", email: "carla.edwards@rushortho.com", alertEmail: "", linkedTo: "" });`);
    win.eval(`ingestEmail(${JSON.stringify(REVISION_EMAIL)}, "Fwd: Decision", "email", "carla.edwards@rushortho.com"); render();`);
    await wait(250);
    const g = suggestions(win)[0];
    check("It records who forwarded it", g.forwardedBy === "carla", g.forwardedBy);
    check("...by name, so an applied change is attributable", g.forwardedByName === "Carla Edwards");
    check("It isn't flagged unverified", g.unverified === false);
    check("The safe change still applied", study(win).revisionsDeadline === "2026-11-14");
    check("The card says who forwarded it", /Forwarded by Carla Edwards/.test(mainText(win)), mainText(win).slice(0, 500));
    dom.window.close();
  }

  console.log("\n-- A sender we can't place changes nothing --");
  {
    const dom = boot();
    const win = await settings(dom);
    win.eval(`ingestEmail(${JSON.stringify(REVISION_EMAIL)}, "Fwd: Decision", "email", "someone@example.com"); render();`);
    await wait(250);
    const g = suggestions(win)[0];
    check("It's flagged unverified", g.unverified === true);
    check("NOTHING was applied, not even the safe date", g.applied.length === 0, g.applied);
    check("...and the study is untouched", study(win).revisionsDeadline === "", study(win).revisionsDeadline);
    check("It's still kept for review", g.status === "pending");
    check("The card explains why nothing happened", /isn't a tracker account/.test(mainText(win)), mainText(win).slice(0, 600));
    check("...and says anyone can send mail to that address", /Anyone can send mail/.test(mainText(win)));
    dom.window.close();
  }

  console.log("\n-- An alert address counts as the person too --");
  {
    const dom = boot();
    const win = await settings(dom);
    // People forward from whichever mailbox they're reading, which may not be their sign-in one.
    win.eval(`state.profiles.push({ id: "tj", name: "Thomas Turinske", email: "tj@rushortho.com", alertEmail: "tj.personal@gmail.com", linkedTo: "" });`);
    win.eval(`ingestEmail(${JSON.stringify(REVISION_EMAIL)}, "Fwd", "email", "tj.personal@gmail.com"); render();`);
    await wait(250);
    check("Matched on the alert address", suggestions(win)[0].forwardedBy === "tj", suggestions(win)[0]);
    dom.window.close();
  }

  console.log("\n-- Who is allowed to act --");
  {
    const dom = boot();
    const win = await settings(dom);
    win.eval(`state.profiles.push({ id: "carla", name: "Carla Edwards", email: "carla.edwards@rushortho.com", alertEmail: "", linkedTo: "" });`);
    win.eval(`ingestEmail(${JSON.stringify(REVISION_EMAIL)}, "Fwd", "email", "carla.edwards@rushortho.com");`);
    await wait(150);
    const id = suggestions(win)[0].id;
    const can = (who) => win.eval(`(function(){ const was = currentUser; currentUser = ${JSON.stringify(who)}; const r = canDecideSuggestion(state.suggestions[0]); currentUser = was; return r; })()`);
    check("An admin can act on anyone's", can({ id: ME, email: "adam.yanke@rushortho.com" }) === true);
    check("The forwarder can act on their own", can({ id: "carla", email: "carla.edwards@rushortho.com" }) === true);
    // Someone who is neither. isAdmin() reads the signed-in profile, so use an id with none.
    win.eval(`state.profiles.push({ id: "divesh", name: "Divesh Sachdev", email: "divesh@rushortho.com", admin: false, alertEmail: "", linkedTo: "" });`);
    check("Somebody else cannot", can({ id: "divesh", email: "divesh@rushortho.com" }) === false);
    dom.window.close();
  }

  console.log("\n-- The rule is enforced on the write, not just in the buttons --");
  {
    const dom = boot();
    const win = await settings(dom);
    win.eval(`state.profiles.push({ id: "carla", name: "Carla Edwards", email: "carla.edwards@rushortho.com", alertEmail: "", linkedTo: "" });`);
    win.eval(`state.profiles.push({ id: "divesh", name: "Divesh Sachdev", email: "divesh@rushortho.com", admin: false, alertEmail: "", linkedTo: "" });`);
    win.eval(`ingestEmail(${JSON.stringify(REVISION_EMAIL)}, "Fwd", "email", "carla.edwards@rushortho.com");`);
    await wait(150);
    const id = suggestions(win)[0].id;
    // Divesh calls accept directly, as a stale page or a browser console could.
    win.eval(`currentUser = { id: "divesh", email: "divesh@rushortho.com" }; acceptSuggestion(${JSON.stringify(id)}, ["decision"]);`);
    await wait(250);
    check("The decision was NOT applied", study(win).decision === "Awaiting decision", study(win).decision);
    check("...and he's told who can", /Carla Edwards|admin/i.test(toastText(win)), toastText(win));
    win.eval(`currentUser = { id: "divesh", email: "divesh@rushortho.com" }; dismissSuggestion(${JSON.stringify(id)});`);
    await wait(250);
    check("Nor can he dismiss it", suggestions(win)[0].status === "pending");
    dom.window.close();
  }

  console.log("\n-- Your own forwards come first --");
  {
    const dom = boot();
    const win = await settings(dom);
    win.eval(`state.profiles.push({ id: "carla", name: "Carla Edwards", email: "carla.edwards@rushortho.com", alertEmail: "", linkedTo: "" });`);
    win.eval(`ingestEmail("Study ORA-25-0042: we regret that we are unable to accept it for publication.", "Carla's forward", "email", "carla.edwards@rushortho.com");`);
    win.eval(`ingestEmail(${JSON.stringify(REVISION_EMAIL)}, "Adam's paste", "paste", ""); render();`);
    await wait(300);
    const t = mainText(win);
    check("Someone else's forward is under its own heading", /WAITING ON SOMEONE ELSE/.test(t), t.slice(0, 900));
    check("...and yours is above it", t.indexOf("Adam's paste") < t.indexOf("WAITING ON SOMEONE ELSE"), [t.indexOf("Adam's paste"), t.indexOf("WAITING ON SOMEONE ELSE")]);
    dom.window.close();
  }

  console.log("\n-- A forward from the edge function is parsed on arrival --");
  {
    const dom = boot();
    const win = await settings(dom);
    win.eval(`state.profiles.push({ id: "carla", name: "Carla Edwards", email: "carla.edwards@rushortho.com", alertEmail: "", linkedTo: "" });`);
    // Exactly the shape ingest-email writes: raw text, no matching done yet.
    win.eval(`state.suggestions.push({
      id: "raw1", createdAt: new Date().toISOString(), source: "email",
      from: "carla.edwards@rushortho.com", subject: "Fwd: Decision",
      text: ${JSON.stringify(REVISION_EMAIL)}, redacted: 0, redactedKinds: [],
      forwardedBy: "carla", forwardedByName: "Carla Edwards", unverified: false,
      studyId: "", basis: "", changes: [], applied: [], status: "pending", needsParse: true
    });`);
    check("It arrives unparsed", suggestions(win).find(g => g.id === "raw1").needsParse === true);
    win.eval("parseIncomingSuggestions(); render();");
    await wait(300);
    const g = suggestions(win).find(x => x.id === "raw1");
    check("It's matched to the study", g.studyId === S1, g.studyId);
    check("The safe date applied itself", study(win).revisionsDeadline === "2026-11-14");
    check("The decision still waits for a person", g.changes.some(c => c.field === "decision"));
    check("It won't be parsed twice", g.needsParse === false);
    check("...and a second pass does nothing", win.eval("parseIncomingSuggestions()") === false);
    dom.window.close();
  }

  console.log("\n-- An unverified forward is never auto-parsed into changes --");
  {
    const dom = boot();
    const win = await settings(dom);
    win.eval(`state.suggestions.push({
      id: "raw2", createdAt: new Date().toISOString(), source: "email",
      from: "stranger@example.com", subject: "Fwd", text: ${JSON.stringify(REVISION_EMAIL)},
      redacted: 0, redactedKinds: [], forwardedBy: "", forwardedByName: "", unverified: true,
      studyId: "", basis: "", changes: [], applied: [], status: "pending", needsParse: true
    });`);
    win.eval("parseIncomingSuggestions(); render();");
    await wait(300);
    const g = suggestions(win).find(x => x.id === "raw2");
    check("It's read, so an admin can see what it claims", g.studyId === S1, g.studyId);
    check("...but nothing was applied", g.applied.length === 0, g.applied);
    check("...and the study is untouched", study(win).revisionsDeadline === "", study(win).revisionsDeadline);
    dom.window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", (e && e.stack) ? e.stack : e); process.exit(1); });
