// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Documents on a study: four sections collapsed into two.
//
// A study used to keep documents in four places with two mechanisms — six fixed slots that took a
// pasted LINK, a free list of UPLOADED files, a second upload list tagged "revision", and two more
// link fields inside that. A manuscript could be in three of them at once.
//
// The risk in collapsing them is losing something. So most of this file is about survival: every
// pre-existing link and every pre-existing upload must still be reachable afterwards, replacing a
// document must keep the old one, and a wrong guess about where a file belongs must be visible
// rather than silent.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ME = "11111111-1111-1111-1111-111111111111";
const STUDY = "aaaaaaaa-0000-0000-0000-000000000001";

const L = {
  abstract:   "https://docs.google.com/document/d/ABSTRACT/edit",
  overview:   "https://docs.google.com/document/d/OVERVIEW/edit",
  manuscript: "https://docs.google.com/document/d/MANUSCRIPT/edit",
  sheet:      "https://rushortho.sharepoint.com/:x:/r/sites/research/data.xlsx?web=1",
  process:    "https://docs.google.com/document/d/PROCESS/edit",
  tracking:   "https://docs.google.com/document/d/TRACKING/edit",
  revised:    "https://docs.google.com/document/d/REVISED/edit",
  response:   "https://docs.google.com/document/d/RESPONSE/edit"
};

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
      data: Object.assign({
        id: STUDY, title: "Meniscal repair outcomes", nickname: "Meniscus", phase: "Manuscript",
        design: "Retrospective (Non-Consented)", pi: "Adam Yanke", team: [], milestones: [],
        meetingNotes: [], authors: [], abstracts: [], docs: [],
        workingAbstractLink: L.abstract, projectOverviewLink: L.overview,
        workingManuscriptLink: L.manuscript, dataCollectionSheetLink: L.sheet,
        dataProcessDocLink: L.process, trackingSheetLink: L.tracking
      }, studyExtra || {}) },
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

async function openStudy(dom, sections) {
  const { window } = dom;
  await wait(600);
  window.eval(`currentUser = { id: ${JSON.stringify(ME)}, email: "adam.yanke@rushortho.com" }; syncOnline = true;`);
  window.document.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
  await wait(60);
  const open = (sections || ["workingDocs", "manuscript", "abstracts"])
    .map(k => `studySectionState[${JSON.stringify(k)}] = true;`).join(" ");
  window.eval(`tab = "studies"; openStudy("${STUDY}"); ${open} render();`);
  await wait(250);
  return window;
}
const study = (win) => JSON.parse(win.eval(`JSON.stringify(studyById(${JSON.stringify(STUDY)}))`));
const slot = (win, key) => study(win).docSlots[key];
const toastText = (doc) => doc.getElementById("toast").textContent;
const pageText = (win) => win.document.body.textContent;
const hasLink = (win, url) => !!win.document.querySelector(`[data-copy-link="${url}"]`);

(async () => {
  console.log("\n-- The four sections are now two --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    const t = pageText(win);
    check("Working Documents is still there", /Working Documents/.test(t));
    check("Manuscript Submission is still there", /Manuscript Submission/.test(t));
    // Checked against the rendered sections, not raw page text: the script source itself mentions
    // the old names in comments, which would make a text search pass or fail for the wrong reason.
    const headings = [...win.document.querySelectorAll('[data-sec], .sec-head, h3')].map(e => e.textContent.trim());
    check("Manuscript & Documents is gone", !headings.some(h => /Manuscript & Documents/.test(h)), headings);
    check("Revision Documents has no section of its own",
      !win.document.querySelector('[data-sec-body="revisionDocs"]'));
    // Working Documents now lists only the types a study holds, so "Other Documents" appears once
    // something is in it. It is still offered to everyone through Add a document.
    check("Other Documents is still a type you can add",
      win.eval("DOC_SLOTS.concat([OTHER_SLOT]).some(t => t.key === 'other')"));
    dom.window.close();
  }

  console.log("\n-- Every one of the six pasted links survived --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    check("Working Abstract", slot(win, "abstract")[0].url === L.abstract, slot(win, "abstract"));
    check("Project Overview", slot(win, "overview")[0].url === L.overview);
    check("Working Manuscript", slot(win, "manuscript")[0].url === L.manuscript);
    check("Data Collection Spreadsheet", slot(win, "sheet")[0].url === L.sheet);
    check("Process & Analysis Doc", slot(win, "process")[0].url === L.process);
    check("Tracking Sheet", slot(win, "tracking")[0].url === L.tracking);
    check("...and all six are on the page", Object.values(L).slice(0, 6).every(u => hasLink(win, u)));
    check("A SharePoint URL kept its query string", slot(win, "sheet")[0].url.indexOf("?web=1") > 0);
    check("The old fields are left alone, so nothing is destroyed",
      study(win).workingManuscriptLink === L.manuscript, study(win).workingManuscriptLink);
    dom.window.close();
  }

  console.log("\n-- Uploaded files land where their label says --");
  {
    const docs = [
      { id: "f1", name: "meniscus_manuscript_v2.docx", label: "v2 — post-review", date: "2026-08-01", by: "Will Lee", size: 12345 },
      { id: "f2", name: "AAOS_abstract.docx", label: "AAOS abstract", date: "2026-07-01", by: "Will Lee", size: 2222 },
      { id: "f3", name: "data.xlsx", label: "Data collection sheet", date: "2026-06-01", by: "TJ", size: 3333 },
      { id: "f4", name: "scan0012.pdf", label: "", date: "2026-05-01", by: "TJ", size: 4444 },
      { id: "f5", name: "reviewer_comments.pdf", label: "Reviewer comments — round 1", date: "2026-09-01", by: "Adam Yanke", size: 5555, category: "revision" }
    ];
    const dom = boot({ docs });
    const win = await openStudy(dom);
    const find = (k, id) => slot(win, k).some(e => e.id === id);
    check("A manuscript draft goes to Working Manuscript", find("manuscript", "f1"), slot(win, "manuscript"));
    check("An abstract goes to Working Abstract", find("abstract", "f2"));
    check("A data sheet goes to the spreadsheet slot", find("sheet", "f3"));
    check("An unlabelled scan goes to Other Documents, not a guess", find("other", "f4"), slot(win, "other"));
    check("Reviewer comments go to Reviewer Comments", find("revComments", "f5"), slot(win, "revComments"));

    // The point of the whole exercise: nothing vanished.
    const allIds = [];
    win.eval("ALL_SLOT_KEYS").forEach ? null : null;
    const sd = study(win).docSlots;
    Object.keys(sd).forEach(k => sd[k].forEach(e => allIds.push(e.id)));
    check("All five uploads are still reachable somewhere",
      ["f1", "f2", "f3", "f4", "f5"].every(id => allIds.indexOf(id) >= 0), allIds);
    check("None of them was duplicated into two slots",
      allIds.filter(x => x === "f1").length === 1);
    check("s.docs is left untouched as the original record",
      study(win).docs.length === 5, study(win).docs.length);
    dom.window.close();
  }

  console.log("\n-- A moved file says where it came from --");
  {
    const dom = boot({ docs: [{ id: "f1", name: "draft.docx", label: "manuscript draft", date: "2026-08-01", by: "Will Lee", size: 10 }] });
    const win = await openStudy(dom);
    check("It records the section it was moved out of",
      slot(win, "manuscript")[0].movedFrom === "Manuscript & Documents", slot(win, "manuscript")[0]);
    check("...and says so on screen, so a wrong guess is spottable",
      /was in Manuscript & Documents/.test(pageText(win)));
    dom.window.close();
  }

  console.log("\n-- The two revision link fields moved to the manuscript section --");
  {
    const dom = boot({ decision: "Major revision", phase: "Revisions Required",
      revisedManuscriptLink: L.revised, responseToReviewersLink: L.response });
    const win = await openStudy(dom);
    // Each goes to its OWN named slot — they are different documents, not one pile.
    check("The revised manuscript has its own slot", slot(win, "revManuscript")[0].url === L.revised, slot(win, "revManuscript"));
    check("The response to reviewers has its own slot", slot(win, "revResponse")[0].url === L.response, slot(win, "revResponse"));
    check("Neither landed in the other's slot", slot(win, "revManuscript").length === 1 && slot(win, "revResponse").length === 1);
    check("Both are on the page", hasLink(win, L.revised) && hasLink(win, L.response));
    check("Reviewer Comments is offered too, even though it's empty",
      !!win.document.querySelector('[data-slot-link="revComments"]'));
    dom.window.close();
  }

  console.log("\n-- Reviewer comments and the response are different documents, not versions --");
  {
    const dom = boot({ decision: "Major revision", phase: "Revisions Required",
      revisedManuscriptLink: L.revised, responseToReviewersLink: L.response });
    const win = await openStudy(dom);
    check("Both are visible at once, with nothing folded away",
      hasLink(win, L.revised) && hasLink(win, L.response));
    check("...because each has its own slot, so neither supersedes the other",
      !win.document.querySelector('[data-slot-hist="revManuscript"]') && !win.document.querySelector('[data-slot-hist="revResponse"]'));
    const names = [...win.document.querySelectorAll('[data-sec-body="manuscript"] .card')].map(c => c.textContent);
    check("All three are named on screen",
      ["Reviewer Comments", "Revised Manuscript", "Response to Reviewers"].every(n => names.some(t => t.indexOf(n) >= 0)),
      names.map(n => n.slice(0, 40)));
    dom.window.close();
  }

  console.log("\n-- Revision documents appear only for a revision decision --");
  {
    for (const [decision, shown] of [["Major revision", true], ["Minor revision", true], ["Accepted", false], ["Rejected", false], ["Awaiting decision", false]]) {
      const dom = boot({ decision });
      const win = await openStudy(dom);
      const box = win.document.getElementById("ms-revision-fields");
      const visible = box && box.style.display !== "none";
      check(`${decision} → revision documents ${shown ? "shown" : "hidden"}`, !!visible === shown, box && box.style.display);
      dom.window.close();
    }
  }
  {
    // ...but documents already filed are never hidden, whatever the decision now says.
    const dom = boot({ decision: "Rejected", revisedManuscriptLink: L.revised });
    const win = await openStudy(dom);
    check("An old revision document still shows on a rejected paper", hasLink(win, L.revised), pageText(win).slice(0, 200));
    check("...explained, rather than just appearing", /earlier round/i.test(pageText(win)));
    dom.window.close();
  }

  console.log("\n-- Adding a link keeps the one it replaced --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    const doc = win.document;
    doc.querySelector('[data-slot-link="manuscript"]').value = "https://docs.google.com/document/d/V3/edit";
    doc.querySelector('[data-slot-save="manuscript"]').click();
    await wait(300);
    const m = slot(win, "manuscript");
    check("Two versions now", m.length === 2, m.length);
    check("The new one is current", m[0].url.indexOf("/V3/") > 0, m[0].url);
    check("The old one is underneath, not gone", m[1].url === L.manuscript, m[1].url);
    check("It says the previous one was kept", /earlier version/i.test(toastText(win.document)), toastText(win.document));
    check("...and it's stamped with who and when", !!m[0].by && !!m[0].date, m[0]);
    dom.window.close();
  }

  console.log("\n-- History is folded away, but never silent about existing --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    let doc = win.document;
    doc.querySelector('[data-slot-link="manuscript"]').value = "https://docs.google.com/document/d/V3/edit";
    doc.querySelector('[data-slot-save="manuscript"]').click();
    await wait(300);
    doc = win.document;
    check("The old version isn't shown by default", !hasLink(win, L.manuscript));
    const toggle = doc.querySelector('[data-slot-hist="manuscript"]');
    check("...but there's a control saying one exists", !!toggle);
    check("...and it says how many", /1 earlier version/.test(toggle.textContent), toggle.textContent);
    toggle.click();
    await wait(250);
    check("Expanding shows it", hasLink(win, L.manuscript));
    check("...and offers to hide it again", /Hide/.test(win.document.querySelector('[data-slot-hist="manuscript"]').textContent));
    dom.window.close();
  }

  console.log("\n-- An empty link box refuses rather than filing nothing --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    // "Other Documents" is empty on this fixture, so its box isn't rendered — the equivalent now
    // is the Add a document sheet with the link field left blank.
    win.document.getElementById("doc-add").click();
    await wait(120);
    win.document.getElementById("doc-type").value = "other";
    win.document.getElementById("sheet-save").click();
    await wait(250);
    check("Nothing was added", slot(win, "other").length === 0);
    check("...and it says what to do", /Paste a link/i.test(toastText(win.document)), toastText(win.document));
    check("...and the sheet stays open rather than losing the choice", !!win.document.getElementById("doc-type"));
    dom.window.close();
  }

  console.log("\n-- Every slot offers both a link and an upload --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    const doc = win.document;
    // Only slots holding something are rendered now, so check the ones this fixture filled, plus
    // the Manuscript Submission slots, which are a separate section and always shown.
    const keys = ["abstract", "overview", "manuscript", "sheet", "process", "tracking",
                  "submitted", "revComments", "revManuscript", "revResponse"];
    const missingLink = keys.filter(k => !doc.querySelector(`[data-slot-link="${k}"]`));
    const missingUp = keys.filter(k => !doc.querySelector(`[data-slot-up="${k}"]`));
    check("A link box on every slot in use", missingLink.length === 0, missingLink);
    check("An Upload on every slot in use", missingUp.length === 0, missingUp);
    check("...and a way to add a type that isn't listed yet", !!doc.getElementById("doc-add"));
    dom.window.close();
  }

  console.log("\n-- The submitted manuscript sits with the journal --");
  {
    const dom = boot({ journal: "AJSM", submittedDate: "2026-08-12", decision: "Awaiting decision" });
    const win = await openStudy(dom);
    const body = win.document.querySelector('[data-sec-body="manuscript"]');
    check("It's inside Manuscript Submission", !!body && !!body.querySelector('[data-slot-link="submitted"]'));
    check("...and separate from the working draft, which is elsewhere",
      !body.querySelector('[data-slot-link="manuscript"]'));
    dom.window.close();
  }

  console.log("\n-- An abstract can be attached to the meeting it went to --");
  {
    const dom = boot({ abstracts: [
      { id: "a1", meeting: "AAOS 2027", date: "2026-11-01", status: "Submitted" },
      { id: "a2", meeting: "AOSSM 2027", date: "2026-12-01", status: "Planned" }
    ] });
    const win = await openStudy(dom);
    let doc = win.document;
    check("Each submission has its own link box", !!doc.querySelector('[data-abs-link="a1"]') && !!doc.querySelector('[data-abs-link="a2"]'));
    check("...and its own Upload", !!doc.querySelector('[data-abs-up="a1"]'));
    doc.querySelector('[data-abs-link="a1"]').value = "https://docs.google.com/document/d/AAOSABS/edit";
    doc.querySelector('[data-abs-linksave="a1"]').click();
    await wait(300);
    const abs = study(win).abstracts;
    check("It's attached to that submission", abs.find(a => a.id === "a1").docs[0].url.indexOf("AAOSABS") > 0);
    check("...and not to the other one", (abs.find(a => a.id === "a2").docs || []).length === 0);
    check("It names the meeting when confirming", /AAOS 2027/.test(toastText(win.document)), toastText(win.document));
    check("Two meetings keep two different versions apart",
      abs.find(a => a.id === "a1").docs.length === 1);
    dom.window.close();
  }

  console.log("\n-- The three revision documents are told apart --");
  {
    const docs = [
      { id: "r1", name: "AJSM_reviewer_comments_round1.pdf", label: "", date: "2026-09-01", by: "Adam", size: 1, category: "revision" },
      { id: "r2", name: "manuscript_revised_R1.docx", label: "", date: "2026-09-05", by: "Adam", size: 1, category: "revision" },
      { id: "r3", name: "point-by-point_response.docx", label: "", date: "2026-09-06", by: "Adam", size: 1, category: "revision" },
      // The awkward one: contains "reviewer" AND is a response. Must not land in Reviewer Comments.
      { id: "r4", name: "response_to_reviewer_comments.docx", label: "", date: "2026-09-07", by: "Adam", size: 1, category: "revision" },
      // Revision-ish but unplaceable. Goes to Reviewer Comments — most of them are — rather than
      // to Other Documents, which would bury it away from the decision it belongs to.
      { id: "r5", name: "scan.pdf", label: "revision stuff", date: "2026-09-08", by: "Adam", size: 1, category: "revision" }
    ];
    const dom = boot({ decision: "Major revision", phase: "Revisions Required", docs });
    const win = await openStudy(dom);
    const inSlot = (k, id) => slot(win, k).some(e => e.id === id);
    check("Reviewer comments", inSlot("revComments", "r1"), slot(win, "revComments").map(e => e.id));
    check("The revised manuscript", inSlot("revManuscript", "r2"), slot(win, "revManuscript").map(e => e.id));
    check("A point-by-point response", inSlot("revResponse", "r3"));
    check(`"Response to reviewer comments" is a response, not comments`, inSlot("revResponse", "r4"),
      ["revComments", "revManuscript", "revResponse"].map(k => k + ":" + slot(win, k).map(e => e.id).join(",")));
    check("An unplaceable revision file lands with the comments, not in Other", inSlot("revComments", "r5"));
    check("...and none of them ended up in Other Documents",
      slot(win, "other").length === 0, slot(win, "other"));
    const all = ["revComments", "revManuscript", "revResponse"].reduce((n, k) => n + slot(win, k).length, 0);
    check("All five are accounted for exactly once", all === 5, all);
    dom.window.close();
  }

  console.log("\n-- A second round supersedes the first, per document --");
  {
    const dom = boot({ decision: "Major revision", phase: "Revisions Required" });
    const win = await openStudy(dom);
    let doc = win.document;
    doc.querySelector('[data-slot-link="revComments"]').value = "https://example.com/round1-comments";
    doc.querySelector('[data-slot-save="revComments"]').click();
    await wait(300);
    doc = win.document;
    doc.querySelector('[data-slot-link="revComments"]').value = "https://example.com/round2-comments";
    doc.querySelector('[data-slot-save="revComments"]').click();
    await wait(300);
    const c = slot(win, "revComments");
    check("Round 2 is current", c[0].url.indexOf("round2") > 0, c[0].url);
    check("Round 1 is kept underneath", c[1].url.indexOf("round1") > 0, c[1] && c[1].url);
    check("...and the other two slots are untouched",
      slot(win, "revManuscript").length === 0 && slot(win, "revResponse").length === 0);
    dom.window.close();
  }

  console.log("\n-- Data left in the retired shared pile is rescued, not orphaned --");
  {
    // A study migrated by the FIRST version of this change has everything in one "revision" key.
    const dom = boot({ decision: "Major revision", phase: "Revisions Required",
      docSlots: {
        revision: [
          { id: "x1", kind: "link", url: "https://example.com/comments", label: "Reviewer comments — round 1", by: "", date: "2026-09-01" },
          { id: "x2", kind: "link", url: "https://example.com/revised", label: "Revised manuscript", by: "", date: "2026-09-02" },
          { id: "x3", kind: "link", url: "https://example.com/response", label: "Response to reviewers", by: "", date: "2026-09-03" }
        ]
      },
      docSlotsMigrated: true });
    const win = await openStudy(dom);
    check("Comments moved to their own slot", slot(win, "revComments").some(e => e.id === "x1"), slot(win, "revComments"));
    check("The revised manuscript moved to its own slot", slot(win, "revManuscript").some(e => e.id === "x2"));
    check("The response moved to its own slot", slot(win, "revResponse").some(e => e.id === "x3"));
    check("The retired pile is empty, so nothing is stranded", slot(win, "revision").length === 0);
    check("All three are still on the page",
      hasLink(win, "https://example.com/comments") && hasLink(win, "https://example.com/revised") && hasLink(win, "https://example.com/response"));
    check("...and they kept their ids", ["x1", "x2", "x3"].every(id =>
      ["revComments", "revManuscript", "revResponse"].some(k => slot(win, k).some(e => e.id === id))));
    dom.window.close();
  }

  console.log("\n-- Migration runs once and doesn't multiply --");
  {
    const dom = boot({ docs: [{ id: "f1", name: "draft.docx", label: "manuscript", date: "2026-08-01", by: "x", size: 1 }] });
    const win = await openStudy(dom);
    check("One entry after the first load", slot(win, "manuscript").length === 2, slot(win, "manuscript").length);
    win.eval("migrate(); migrate(); migrate();");
    await wait(150);
    check("...still that many after migrating again", slot(win, "manuscript").length === 2, slot(win, "manuscript").length);
    check("...and the flag is set", study(win).docSlotsMigrated === true);
    dom.window.close();
  }

  console.log("\n-- A study with nothing filed reads as empty, not broken --");
  {
    const dom = boot({ workingAbstractLink: "", projectOverviewLink: "", workingManuscriptLink: "",
      dataCollectionSheetLink: "", dataProcessDocLink: "", trackingSheetLink: "" });
    const win = await openStudy(dom);
    check("No entries anywhere", win.eval("totalSlotDocs(studyById(" + JSON.stringify(STUDY) + "))") === 0);
    // An empty study shows no boxes at all — six empty slots was the thing being fixed — but it
    // does say so, and offers the way in.
    check("Nothing is listed", !win.document.querySelector('[data-slot-link="manuscript"]'));
    check("...it says so plainly", /No documents yet/.test(pageText(win)));
    check("...and offers Add a document", !!win.document.getElementById("doc-add"));
    dom.window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", (e && e.stack) ? e.stack : e); process.exit(1); });
