// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Journal decisions, and what they gate.
//
// Before this, the manuscript section showed "Revisions received" and "Revisions due" on every
// study — including ones accepted outright or rejected, where those fields imply work that
// doesn't exist. The decision is now the spine: revision fields appear only for the two outcomes
// that create revision work, rejection offers to file the round away rather than being a dead
// end, and an accepted paper gets its own phase so it isn't mistaken for published.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ME = "11111111-1111-1111-1111-111111111111";
const STUDY = "aaaaaaaa-0000-0000-0000-000000000001";

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
    { id: STUDY, kind: "study", updated_at: now,
      data: Object.assign({ id: STUDY, title: "Meniscal repair outcomes", phase: "Submitted",
        design: "Retrospective (Non-Consented)", pi: "Adam Yanke", team: [], abstracts: [], docs: [],
        milestones: [], meetingNotes: [], authors: [], journal: "AJSM", submittedDate: "2026-08-12",
        journalTrackingId: "AJSM-26-1234" }, studyExtra || {}) },
    { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
      data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} } }
  ];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
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

async function openStudy(dom) {
  const { window } = dom;
  await wait(600);
  window.eval(`currentUser = { id: ${JSON.stringify(ME)}, email: "adam.yanke@rushortho.com" }; syncOnline = true;`);
  window.document.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
  await wait(60);
  window.eval(`tab = "studies"; openStudy("${STUDY}"); studySectionState["manuscript"] = true; studySectionState["revisionDocs"] = true; render();`);
  await wait(250);
  return window.document;
}
const study = (dom) => JSON.parse(dom.window.eval(`JSON.stringify(studyById("${STUDY}"))`));
const revisionShown = (doc) => {
  const el = doc.getElementById("ms-revision-fields");
  return !!el && el.style.display !== "none";
};
async function setDecision(dom, doc, value) {
  const sel = doc.getElementById("ms-decision");
  sel.value = value;
  sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await wait(300);
  return dom.window.document;
}
const toastText = (doc) => doc.getElementById("toast").textContent;

(async () => {
  console.log("\n-- The decision drives whether revision fields exist at all --");
  {
    const dom = boot({ decision: "Awaiting decision" });
    let doc = await openStudy(dom);
    check("Awaiting: no revision fields", !revisionShown(doc));
    check("...and no decision date field either", !doc.getElementById("ms-decision-date"));

    doc = await setDecision(dom, doc, "Major revision");
    check("Major revision: revision fields appear", revisionShown(doc));
    check("...along with a decision date", !!doc.getElementById("ms-decision-date"));
    check("...both dates offered", !!doc.getElementById("ms-revisions-received") && !!doc.getElementById("ms-revisions-deadline"));

    doc = await setDecision(dom, doc, "Minor revision");
    check("Minor revision: still shown", revisionShown(doc));

    doc = await setDecision(dom, doc, "Accepted");
    check("Accepted: revision fields gone", !revisionShown(doc));

    doc = await setDecision(dom, doc, "Rejected");
    check("Rejected: revision fields gone", !revisionShown(doc));
    dom.window.close();
  }

  console.log("\n-- Recording a decision stamps the date, once --");
  {
    const dom = boot({ decision: "Awaiting decision" });
    let doc = await openStudy(dom);
    doc = await setDecision(dom, doc, "Major revision");
    const s1 = study(dom);
    check("A decision date is filled in automatically", !!s1.decisionDate, s1.decisionDate);
    // Change the date by hand, then change the decision — the hand-entered date must survive.
    dom.window.eval(`(function(){ var s = studyById("${STUDY}"); s.decisionDate = "2026-09-01"; upsertStudy(s); })();`);
    await wait(150);
    doc = await setDecision(dom, doc, "Minor revision");
    check("A date already entered is never overwritten", study(dom).decisionDate === "2026-09-01", study(dom).decisionDate);
    // Going back to awaiting clears it, because there is no decision to date.
    doc = await setDecision(dom, doc, "Awaiting decision");
    check("Back to awaiting clears the date", study(dom).decisionDate === "", study(dom).decisionDate);
    dom.window.close();
  }

  console.log("\n-- The phase is offered, never forced --");
  {
    const dom = boot({ decision: "Awaiting decision", phase: "Submitted" });
    let doc = await openStudy(dom);
    doc = await setDecision(dom, doc, "Major revision");
    check("The phase has NOT moved on its own", study(dom).phase === "Submitted", study(dom).phase);
    const t = doc.body.textContent;
    check("It offers the move", /Revisions Required/.test(t), t.slice(0, 300));
    check("...with a button", !!doc.getElementById("phase-offer-yes"));
    check("...and a way to decline it", !!doc.getElementById("phase-offer-no"));
    // The point of this being a banner and not a toast: it has to survive being ignored for a
    // while, and survive the re-renders that any other edit on the page causes.
    dom.window.eval("render();");
    await wait(200);
    doc = dom.window.document;
    check("It's still there after a re-render", !!doc.getElementById("phase-offer-yes"));
    await wait(8000);
    doc = dom.window.document;
    check("...and still there eight seconds later, unlike a toast",
      !!doc.getElementById("phase-offer-yes"));
    doc.getElementById("phase-offer-yes").click();
    await wait(250);
    doc = dom.window.document;
    check("Tapping it moves the phase", study(dom).phase === "Revisions Required", study(dom).phase);
    check("...and says where to change it back", /Edit Study/.test(toastText(doc)), toastText(doc));
    check("The question is gone once answered", !doc.getElementById("phase-offer-yes"));
    dom.window.close();
  }

  console.log("\n-- Ignoring the offer changes nothing --");
  {
    const dom = boot({ decision: "Awaiting decision", phase: "Submitted" });
    let doc = await openStudy(dom);
    doc = await setDecision(dom, doc, "Minor revision");
    await wait(300);   // let it sit, don't tap
    check("Phase untouched", study(dom).phase === "Submitted", study(dom).phase);
    check("But the decision is saved regardless", study(dom).decision === "Minor revision");
    // Declining explicitly is the other half: it answers the question without touching anything.
    doc.getElementById("phase-offer-no").click();
    await wait(250);
    doc = dom.window.document;
    check("Declining leaves the phase alone", study(dom).phase === "Submitted", study(dom).phase);
    check("...and keeps the decision", study(dom).decision === "Minor revision");
    check("...and says so, so it doesn't read like an undo",
      /still recorded/i.test(toastText(doc)), toastText(doc));
    check("The question is gone", !doc.getElementById("phase-offer-no"));
    dom.window.close();
  }

  console.log("\n-- Accepted offers the In Press phase, not Published --");
  {
    const dom = boot({ decision: "Awaiting decision", phase: "Submitted" });
    let doc = await openStudy(dom);
    doc = await setDecision(dom, doc, "Accepted");
    const offer = doc.getElementById("phase-offer-yes");
    check("It suggests Accepted / In Press", /Accepted \/ In Press/.test(offer.textContent), offer.textContent);
    check("...not Published", !/Published/.test(offer.textContent), offer.textContent);
    offer.click();
    await wait(250);
    check("Phase becomes Accepted / In Press", study(dom).phase === "Accepted / In Press", study(dom).phase);
    dom.window.close();
  }

  console.log("\n-- In Press is a working phase, not a finished one --");
  {
    const dom = boot({ decision: "Accepted", phase: "Accepted / In Press" });
    const { window } = dom;
    await openStudy(dom);
    check("It counts as active", window.eval(`isActive(studyById("${STUDY}"))`) === true);
    check("...so it is NOT exempt from staleness",
      window.eval(`FRESHNESS_EXEMPT_PHASES.indexOf("Accepted / In Press")`) < 0);
    check("Published still is exempt", window.eval(`FRESHNESS_EXEMPT_PHASES.indexOf("Published")`) >= 0);
    check("It appears in every design's phase list",
      window.eval(`Object.keys(TRACK_PHASES).every(function(k){ return TRACK_PHASES[k].indexOf("Accepted / In Press") > 0; })`) === true);
    check("...positioned between Submitted and Published",
      window.eval(`PHASES.indexOf("Accepted / In Press") > PHASES.indexOf("Submitted") && PHASES.indexOf("Accepted / In Press") < PHASES.indexOf("Published")`) === true);
    check("Tasks stay open in that phase, so proofs don't go quiet",
      window.eval(`PHASE_SECTIONS["Accepted / In Press"].indexOf("tasks")`) >= 0);
    dom.window.close();
  }

  console.log("\n-- Rejection files the round away instead of being a dead end --");
  {
    const dom = boot({ decision: "Awaiting decision" });
    let doc = await openStudy(dom);
    doc = await setDecision(dom, doc, "Rejected");
    check("A 'file it away' button appears", !!doc.getElementById("ms-resubmit"));
    check("...explaining nothing is deleted", /nothing is deleted/i.test(doc.getElementById("main").textContent));

    doc.getElementById("ms-resubmit").click();
    await wait(350);
    const s = study(dom);
    check("The round is kept", (s.priorSubmissions || []).length === 1, s.priorSubmissions);
    const p = s.priorSubmissions[0];
    check("...with the journal", p.journal === "AJSM", p);
    check("...the submission date", p.submittedDate === "2026-08-12", p);
    check("...the tracking ID", p.trackingId === "AJSM-26-1234", p);
    check("...and the outcome", p.decision === "Rejected", p);

    check("The live journal is cleared for the next one", s.journal === "" && s.submittedDate === "" && s.journalTrackingId === "");
    check("...and so is the decision", s.decision === "" && s.decisionDate === "");
    check("It says where the old one went", /Previous Submissions/i.test(toastText(doc)), toastText(doc));

    doc = dom.window.document;
    check("The history is shown on the page", /PREVIOUS SUBMISSIONS/.test(doc.getElementById("main").textContent));
    check("...naming the journal and outcome",
      /AJSM/.test(doc.getElementById("main").textContent) && /Rejected/.test(doc.getElementById("main").textContent));
    dom.window.close();
  }

  console.log("\n-- A second rejection stacks, it doesn't replace --");
  {
    const dom = boot({ decision: "Rejected",
      priorSubmissions: [{ id: "p1", journal: "Arthroscopy", submittedDate: "2026-05-04",
                           trackingId: "ART-1", decision: "Rejected", decisionDate: "2026-06-19" }] });
    let doc = await openStudy(dom);
    doc.getElementById("ms-resubmit").click();
    await wait(350);
    const s = study(dom);
    check("Both rounds are kept", (s.priorSubmissions || []).length === 2, s.priorSubmissions.map(p => p.journal));
    check("The older one survives", s.priorSubmissions.some(p => p.journal === "Arthroscopy"));
    check("...and the newer one is there too", s.priorSubmissions.some(p => p.journal === "AJSM"));
    dom.window.close();
  }

  console.log("\n-- Revision documents now live inside the manuscript section --");
  {
    // The standalone Revision Documents section is gone. The gate is the same, though: the place
    // to put reviewer comments appears only for a decision that creates revision work.
    const dom = boot({ decision: "Accepted" });
    const doc = await openStudy(dom);
    const box = doc.getElementById("ms-revision-fields");
    check("Nothing to respond to, so the revision area is hidden", box && box.style.display === "none", box && box.style.display);
    check("The old standalone section is gone", !doc.querySelector('[data-sec-body="revisionDocs"]'));
    dom.window.close();
  }
  {
    const dom = boot({ decision: "Rejected" });
    const doc = await openStudy(dom);
    const box = doc.getElementById("ms-revision-fields");
    check("Rejected hides it too", box && box.style.display === "none");
    dom.window.close();
  }
  {
    const dom = boot({ decision: "Major revision" });
    const doc = await openStudy(dom);
    const box = doc.getElementById("ms-revision-fields");
    check("A revision decision shows it", box && box.style.display !== "none");
    // Three named slots now, not one pile: the reviewers' letter, the revised manuscript and the
    // reply to them are different documents.
    check("Reviewer Comments has its own slot", !!box.querySelector('[data-slot-link="revComments"]'));
    check("So does the Revised Manuscript", !!box.querySelector('[data-slot-link="revManuscript"]'));
    check("So does the Response to Reviewers", !!box.querySelector('[data-slot-link="revResponse"]'));
    check("...and each can take an upload", ["revComments", "revManuscript", "revResponse"]
      .every(k => !!box.querySelector(`[data-slot-up="${k}"]`)));
    dom.window.close();
  }
  {
    // Files already uploaded must never be hidden just because the decision changed.
    const dom = boot({ decision: "Accepted",
      docs: [{ id: "d1", name: "reviewer-comments.pdf", category: "revision", date: "2026-07-01", by: "Adam", size: 1000 }] });
    const doc = await openStudy(dom);
    const body = doc.querySelector('[data-sec-body="manuscript"]');
    check("An existing revision doc is still listed on an accepted paper",
      /reviewer-comments\.pdf/.test(body.textContent), body.textContent.slice(0, 200));
    check("...and is explained rather than just appearing",
      /earlier round/i.test(body.textContent), body.textContent.slice(0, 300));
    dom.window.close();
  }

  console.log("\n-- Existing studies are migrated sensibly --");
  {
    const dom = boot({});  // no decision field at all, phase Submitted
    const { window } = dom;
    await openStudy(dom);
    check("A submitted study becomes Awaiting decision", study(dom).decision === "Awaiting decision", study(dom).decision);
    dom.window.close();
  }
  {
    const dom = boot({ phase: "Revisions Required", revisionsReceivedDate: "2026-07-20" });
    await openStudy(dom);
    const s = study(dom);
    check("A study in Revisions Required gets a revision decision", s.decision === "Major revision", s.decision);
    check("...dated from the revisions-received date", s.decisionDate === "2026-07-20", s.decisionDate);
    dom.window.close();
  }
  {
    const dom = boot({ phase: "Published" });
    await openStudy(dom);
    check("A published study reads as Accepted", study(dom).decision === "Accepted", study(dom).decision);
    dom.window.close();
  }
  {
    const dom = boot({ phase: "Analysis", journal: "", submittedDate: "", journalTrackingId: "" });
    await openStudy(dom);
    check("An unsubmitted study gets no decision at all", study(dom).decision === "", study(dom).decision);
    dom.window.close();
  }

  console.log("\n-- The collapsed header says where the paper stands --");
  {
    const dom = boot({ decision: "Major revision" });
    const dom2 = dom;
    const doc = await openStudy(dom2);
    dom2.window.eval(`studySectionState["manuscript"] = false; render();`);
    await wait(200);
    const header = [...doc.querySelectorAll("[data-sec-toggle]")].find(h => h.dataset.secToggle === "manuscript");
    check("Journal and decision both show", /AJSM/.test(header.textContent) && /Major revision/.test(header.textContent),
      header.textContent.trim());
    dom.window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
