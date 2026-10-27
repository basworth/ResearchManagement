// The guided "New study" — 27 Oct 2026.
//
// Adam: a series of questions that walks through every field, the default for a new study, and
// what a meeting-created study opens to so someone can finish it. It is the same form shown one
// question at a time, so these tests hold three things: it really steps (and won't move past an
// empty title), "Show all fields" gives the whole form back, and saving writes the same study the
// plain form would — plus the funding and first task it now asks about.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const ME = "test-user-1";
const now = new Date().toISOString();
const items = () => [
  { id: ME, kind: "profile", updated_at: now, workspace: "sports-yanke",
    data: { id: ME, email: "a@example.com", name: "Adam Yanke", position: "Clinician", reportsTo: "", alertEmail: "",
      alertEmailAsked: true, degreesAsked: true, tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: true } },
  { id: "ms1", kind: "study", updated_at: now, workspace: "sports-yanke",
    data: { id: "ms1", title: "Cartilage thickness mapping statistical shape model", nickname: "", pi: "Adam Yanke",
      team: ["Adam Yanke", "Thomas Turinske"], phase: "Concept", design: "Prospective (Consented)", fromMeeting: true,
      noteEntries: [{ id: "n1", text: "Started from a meeting update: could be its own paper", date: "2026-10-26", archivedOn: "" }] } },
  { id: "mtg1", kind: "suggestion", updated_at: now, workspace: "sports-yanke",
    data: { id: "mtg1", source: "meeting", status: "applied", subject: "Meeting", createdAt: now, forwardedBy: ME,
      undoUntil: new Date(Date.now() + 86400e3).toISOString(), repliedTo: [], notApplied: [],
      applied: [{ id: "c1", type: "newStudy", studyId: "ms1", study: "New studies", label: "New study", from: "",
        to: "Cartilage thickness mapping statistical shape model", evidence: "could be its own paper", confidence: 0.8,
        undo: { kind: "studyShelve", studyId: "ms1" } }] } },
];
function boot() {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items: items() }) };
    } });
  return dom.window;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}
(async () => {
  const w = boot(); await wait(700);
  const ev = c => w.eval(c), d = w.document;
  const visible = (sel) => { const el = d.querySelector(sel); if (!el) return false; let n = el; while (n && n !== d.body) { if (n.style && n.style.display === "none") return false; n = n.parentElement; } return true; };

  console.log("\n-- New study is guided, one question at a time --");
  ev(`openStudyForm(null)`); await wait(50);
  check("four questions", d.querySelectorAll("[data-wz-step]").length === 4);
  check("starts on title / whose study", visible("#f-title") && !visible("#f-design") && /1 of 4/.test(d.getElementById("wz-count").textContent));
  check("Save hidden until the last step", d.getElementById("sheet-save").style.visibility === "hidden");
  d.getElementById("wz-next").click(); await wait(20);
  check("won't move past an empty title", visible("#f-title") && /1 of 4/.test(d.getElementById("wz-count").textContent));
  d.getElementById("f-title").value = "Rotational profile SSM";
  d.getElementById("wz-next").click(); await wait(20);
  check("step 2 asks who's involved", visible("#f-team-list") && !visible("#f-title") && /Who's involved/.test(d.getElementById("wz-q").textContent));
  d.getElementById("wz-next").click(); await wait(20);
  check("step 3: design, phase, priority", visible("#f-design") && visible("#f-phase") && visible("#f-priority"));
  d.getElementById("wz-back").click(); await wait(20);
  check("Back goes back", visible("#f-team-list"));
  d.getElementById("wz-next").click(); d.getElementById("wz-next").click(); await wait(20);
  check("step 4: IRB, NCT, funding, first task", visible("#f-irb") && visible("#f-nct") && visible("#f-grant-source") && visible("#f-first-task"));
  check("...and Save appears", d.getElementById("sheet-save").style.visibility === "visible" && /Save study/.test(d.getElementById("wz-next").textContent));
  d.getElementById("f-grant-source").value = "OREF";
  d.getElementById("f-first-task").value = "Draft the protocol";
  d.getElementById("f-first-task-due").value = "2026-11-15";
  d.getElementById("wz-next").click(); await wait(80);
  const made = JSON.parse(ev(`JSON.stringify(state.studies.find(s => s.title === "Rotational profile SSM") || null)`));
  check("saving creates the study", !!made, made);
  check("...with its funding source", made && made.grant && made.grant.source === "OREF" && made.grant.enabled === true, made && made.grant);
  const task = JSON.parse(ev(`JSON.stringify(state.tasks.find(t => t.title === "Draft the protocol") || null)`));
  check("...and its first task, on that study, assigned to me, with the due date", task && made && task.studyId === made.id && task.due === "2026-11-15" && task.assignees[0] === "Adam Yanke", task);

  console.log("\n-- Show all fields gives the whole form back --");
  ev(`openStudyForm(null)`); await wait(50);
  d.getElementById("wz-all").click(); await wait(20);
  check("every field visible at once", visible("#f-title") && visible("#f-team-list") && visible("#f-design") && visible("#f-irb"));
  check("...with the normal Save", d.getElementById("sheet-save").style.visibility === "visible" && !d.getElementById("wz-nav"));
  ev(`closeSheet()`); await wait(20);

  console.log("\n-- Editing an existing study is the plain form, as before --");
  ev(`openStudyForm(studyById("ms1"))`); await wait(50);
  check("no steps", d.querySelectorAll("[data-wz-step]").length === 0 && !d.getElementById("f-first-task"));
  ev(`closeSheet()`); await wait(20);

  console.log("\n-- A study a meeting started: Finish setting up --");
  ev(`tab = "settings"; render()`); await wait(80);
  const btn = d.querySelector('[data-mtg-edit="mtg1"][data-mtg-change="c1"].mini-btn');
  check("the meeting card offers Finish setting up", btn && /Finish setting up/.test(btn.textContent), btn && btn.textContent);
  btn.click(); await wait(60);
  check("it opens the guided questions, pre-filled from the meeting",
    d.querySelectorAll("[data-wz-step]").length === 4 && d.getElementById("f-title").value === "Cartilage thickness mapping statistical shape model"
    && /could be its own paper/.test(d.getElementById("wz-head").textContent));
  check("...with the people heard already ticked", [...d.querySelectorAll(".f-team-pick")].filter(c => c.checked).map(c => c.dataset.name).includes("Thomas Turinske"));
  d.getElementById("f-nickname").value = "Thickness SSM";
  d.getElementById("sheet-save").click(); await wait(80);
  check("finishing updates that study, not a new one", ev(`studyById("ms1").nickname`) === "Thickness SSM" && ev(`state.studies.filter(s => /thickness mapping/i.test(s.title)).length`) === 1);
  check("...and marks it set up, so the card says Edit", ev(`studyById("ms1").setupDone`) === true);
  ev(`render()`); await wait(60);
  const btn2 = d.querySelector('[data-mtg-edit="mtg1"][data-mtg-change="c1"].mini-btn');
  check("the button now reads Edit", btn2 && /^Edit$/.test(btn2.textContent.trim()), btn2 && btn2.textContent);

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
