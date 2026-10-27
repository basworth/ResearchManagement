// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Reading a meeting transcript into Suggested Updates.
//
// A weekly research meeting walks through a dozen studies, so unlike an email this has to be cut
// into the part belonging to each. And it's much weaker evidence: a journal writes "we require
// major revision", a person says "I think they want revisions, or was that the other one". So the
// interesting assertions here are about restraint — what it refuses to attribute, and the fact
// that nothing from a transcript applies itself.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ME = "11111111-1111-1111-1111-111111111111";
const S1 = "aaaaaaaa-0000-0000-0000-000000000001";
const S2 = "aaaaaaaa-0000-0000-0000-000000000002";
const S3 = "aaaaaaaa-0000-0000-0000-000000000003";

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

const study = (id, title, nick, extra) => ({
  id, kind: "study", updated_at: now,
  data: Object.assign({
    id, title, nickname: nick, phase: "Submitted", design: "Retrospective (Non-Consented)",
    pi: "Adam Yanke", team: [], abstracts: [], docs: [], milestones: [], meetingNotes: [],
    authors: [], decision: "Awaiting decision", revisionsDeadline: "", irbExpiry: ""
  }, extra || {})
});

function boot() {
  const items = [
    { id: ME, kind: "profile", updated_at: now,
      data: { id: ME, name: "Adam Yanke", email: "adam.yanke@rushortho.com", position: "Clinician",
              admin: true, reportsTo: "", alertEmail: "", linkedTo: "", alertEmailAsked: true, degreesAsked: true } },
    study(S1, "Meniscal repair outcomes in adolescent athletes", "Meniscus",
      { irb: "ORA-24-0117", journalTrackingId: "AJSM-26-1234" }),
    study(S2, "Cartilage thickness mapping study", "Cartilage", { irb: "ORA-25-0042" }),
    study(S3, "Rotator cuff healing rates", "Rotator Cuff", { irb: "ORA-25-0099" }),
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
const suggestions = (win) => JSON.parse(win.eval("JSON.stringify(state.suggestions || [])"));
const studyOf = (win, id) => JSON.parse(win.eval(`JSON.stringify(studyById(${JSON.stringify(id)}))`));
const toastText = (win) => win.document.getElementById("toast").textContent;
const mainText = (win) => win.document.getElementById("main").textContent;

const TRANSCRIPT = `Adam Yanke: Right, let's go through the list.
Adam Yanke: First up, ORA-24-0117, the meniscus paper. AJSM came back with major revision.
Carla Edwards: Revisions are due by November 14, 2026, so we have a bit of time.
Will Lee: I'll pull the reviewer comments together this week.
Adam Yanke: Next, ORA-25-0042, cartilage thickness. Continuing review, the approval period ends March 3, 2027.
Carla Edwards: Noted, I'll put in the renewal.
Adam Yanke: And that's everything. Rotator Cuff we'll pick up next week, nothing new.
Will Lee: Sounds good.`;

(async () => {
  console.log("\n-- Cutting a transcript into studies --");
  {
    const dom = boot();
    const win = await settings(dom);
    const segs = JSON.parse(win.eval(`JSON.stringify(transcriptSegments(${JSON.stringify(TRANSCRIPT)}).map(function(s){ return { id: s.study.id, basis: s.basis, text: s.text }; }))`));
    const ids = segs.map(s => s.id);
    check("It found the meniscus study", ids.indexOf(S1) >= 0, ids);
    check("...and the cartilage study", ids.indexOf(S2) >= 0);
    check("...and rotator cuff, which was named", ids.indexOf(S3) >= 0);
    const s1 = segs.find(s => s.id === S1);
    check("The meniscus segment carries its own lines", /major revision/i.test(s1.text), s1.text);
    check("...including the line after, where the date was said", /November 14/.test(s1.text));
    check("...and not the cartilage discussion", !/March 3/.test(s1.text), s1.text);
    dom.window.close();
  }

  console.log("\n-- What it proposes --");
  {
    const dom = boot();
    const win = await settings(dom);
    win.eval(`ingestTranscript(${JSON.stringify(TRANSCRIPT)}, "Weekly Research Meeting 9/28"); render();`);
    await wait(300);
    const gs = suggestions(win);
    // One per study DISCUSSED, not just per study with a field change: the point of uploading a
    // transcript is that what was said lands on the study, and "nothing new this week" is itself
    // worth recording.
    check("One suggestion per study discussed", gs.length === 3, gs.map(g => g.subject));
    check("...including the one with no field change, as a note",
      gs.find(g => g.studyId === S3).changes.every(c => c.field === "addNote"),
      gs.find(g => g.studyId === S3).changes);
    const men = gs.find(g => g.studyId === S1);
    check("The meniscus decision was heard", men.changes.some(c => c.field === "decision" && c.to === "Major revision"), men.changes);
    check("...and the revision deadline", men.changes.some(c => c.field === "revisionsDeadline" && c.to === "2026-11-14"), men.changes);
    const cart = gs.find(g => g.studyId === S2);
    check("The cartilage IRB expiry was heard", cart.changes.some(c => c.field === "irbExpiry" && c.to === "2027-03-03"), cart.changes);
    // The bug this guards: a context window running past "next up, the cartilage study" and
    // handing that study's date to the meniscus paper.
    check("The cartilage date did NOT leak onto the meniscus study",
      !men.changes.some(c => c.field === "irbExpiry"), men.changes);
    check("Each is named for its study, so the queue reads clearly",
      /Meniscus/.test(men.subject) && /Cartilage/.test(cart.subject), [men.subject, cart.subject]);
    check("...and carries the meeting name", /Weekly Research Meeting/.test(men.subject));
    dom.window.close();
  }

  console.log("\n-- NOTHING from a transcript applies itself --");
  {
    const dom = boot();
    const win = await settings(dom);
    win.eval(`ingestTranscript(${JSON.stringify(TRANSCRIPT)}, "Weekly"); render();`);
    await wait(300);
    const gs = suggestions(win);
    check("No change is marked safe", gs.every(g => g.changes.every(c => !c.safe)),
      gs.map(g => g.changes.map(c => [c.field, c.safe])));
    check("Nothing was applied", gs.every(g => g.applied.length === 0));
    // The IRB expiry would have applied itself from an email — the field was empty. From a
    // transcript it must not.
    check("The empty IRB expiry was NOT filled in", studyOf(win, S2).irbExpiry === "", studyOf(win, S2).irbExpiry);
    check("The decision was not changed", studyOf(win, S1).decision === "Awaiting decision");
    check("The revision deadline was not set", studyOf(win, S1).revisionsDeadline === "");
    check("Everything is waiting on a person", gs.every(g => g.status === "pending"));
    check("...and each proposal says it was heard, not read",
      gs.every(g => g.changes.every(c => /heard in the meeting/.test(c.why))), gs[0].changes[0].why);
    dom.window.close();
  }

  console.log("\n-- Accepting one still works --");
  {
    const dom = boot();
    const win = await settings(dom);
    win.eval(`ingestTranscript(${JSON.stringify(TRANSCRIPT)}, "Weekly"); render();`);
    await wait(300);
    const g = suggestions(win).find(x => x.studyId === S1);
    win.eval(`acceptSuggestion(${JSON.stringify(g.id)}, ["decision"]);`);
    await wait(300);
    check("The decision applied when a person chose it", studyOf(win, S1).decision === "Major revision");
    check("...and the deadline is still waiting, because it wasn't ticked",
      suggestions(win).find(x => x.id === g.id).changes.some(c => c.field === "revisionsDeadline"));
    dom.window.close();
  }

  console.log("\n-- Timestamps and speaker labels don't confuse it --");
  {
    const dom = boot();
    const win = await settings(dom);
    const vtt = `WEBVTT

1
00:00:12.000 --> 00:00:18.500
Adam Yanke: ORA-24-0117, AJSM came back with major revision.

2
00:00:18.500 --> 00:00:24.000
Carla Edwards: Revisions due by November 14, 2026.`;
    const cleaned = win.eval(`cleanTranscript(${JSON.stringify(vtt)})`);
    check("VTT header removed", !/WEBVTT/.test(cleaned), cleaned);
    check("Cue numbers removed", !/^\s*1\s*$/m.test(cleaned));
    check("Time ranges removed", !/-->/.test(cleaned), cleaned);
    check("The words survive", /major revision/.test(cleaned) && /November 14/.test(cleaned));
    win.eval(`ingestTranscript(${JSON.stringify(vtt)}, "Zoom"); render();`);
    await wait(300);
    const gs = suggestions(win);
    check("It still reads the decision", gs.some(g => g.changes.some(c => c.field === "decision" && c.to === "Major revision")), gs);
    check("...and the real date, not a timestamp",
      gs.some(g => g.changes.some(c => c.field === "revisionsDeadline" && c.to === "2026-11-14")),
      gs.map(g => g.changes));
    dom.window.close();
  }

  console.log("\n-- Patient data is stripped before anything is stored --");
  {
    const dom = boot();
    const win = await settings(dom);
    const dirty = `Adam Yanke: ORA-24-0117, major revision from AJSM.
Carla Edwards: The patient with MRN 00456789 is the one we excluded, DOB: 03/14/1998.`;
    win.eval(`ingestTranscript(${JSON.stringify(dirty)}, ""); render();`);
    await wait(400);
    const g = suggestions(win)[0];
    check("No MRN stored", !/00456789/.test(g.text), g.text);
    check("No date of birth stored", !/03\/14\/1998/.test(g.text), g.text);
    check("It counts what it removed", g.redacted >= 2, g.redacted);
    check("The study still matched", g.studyId === S1);
    dom.window.close();
  }

  console.log("\n-- A transcript about nothing we know --");
  {
    const dom = boot();
    const win = await settings(dom);
    win.eval(`ingestTranscript("Adam Yanke: Let's talk about the budget and the new fellow.", ""); render();`);
    await wait(400);
    check("Nothing is created", suggestions(win).length === 0);
    dom.window.close();
  }

  console.log("\n-- A study discussed with nothing actionable still gets a note --");
  {
    const dom = boot();
    const win = await settings(dom);
    win.eval(`ingestTranscript("Adam Yanke: ORA-25-0099, rotator cuff. Nothing new this week, carry on.", ""); render();`);
    await wait(400);
    const gs = suggestions(win);
    check("It's queued as a note", gs.length === 1 && gs[0].changes.every(c => c.field === "addNote"), gs);
    check("...carrying what was said", /Nothing new this week/.test(gs[0].changes[0].to), gs[0].changes[0].to);
    check("...and still not applied on its own", gs[0].applied.length === 0);
    dom.window.close();
  }

  // 27 Oct: the paste/upload box is gone (Adam: "let's make people use the email route"). Forwarded
  // meetings go through the meeting reader on the server; ingestTranscript is still exercised above.
  console.log("\n-- The screen --");
  {
    const dom = boot();
    const win = await settings(dom);
    const doc = win.document;
    check("No transcript box, label or upload any more", !doc.getElementById("tx-body") && !doc.getElementById("tx-label") && !doc.getElementById("tx-file"));
    check("It says to forward instead", /studyupdates@studypipeline\.com/.test(mainText(win)));
    win.eval(`ingestTranscript(${JSON.stringify(TRANSCRIPT)}, "Weekly Research Meeting 9/28"); render();`);
    await wait(400);
    check("A transcript still becomes suggestions", suggestions(win).length === 3, suggestions(win).length);
    check("The cards say where they came from", /from a meeting transcript/.test(mainText(win)), mainText(win).slice(0, 1200));
    dom.window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", (e && e.stack) ? e.stack : e); process.exit(1); });
