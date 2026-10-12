// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Two purpose-built Worklist layouts: initiation stage status (submitted/passed dates, N/A
// counts as cleared) and an enrolling summary with aggregate-only follow-up counts.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const past = new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10);

const study = (o) => ({ id: o.id, kind: "study", data: Object.assign({
  team: [], priority: "Medium", milestones: [], nickname: "", pi: "Adam Yanke"
}, o), updated_at: now });

const mockItems = [
  study({ id: "init1", title: "Prospective In Initiation", design: "Prospective (Consented)", phase: "Initiation", irb: "ORA-1",
    initiation: { caApproved: true, sportsSubmission: true, irbApproved: false, piqBuilt: false, ready: false } }),
  study({ id: "init2", title: "Second Initiation", design: "Prospective (Consented)", phase: "Initiation", irb: "ORA-2" }),
  study({ id: "retroInit", title: "Retro In Initiation", design: "Retrospective (Non-Consented)", phase: "Initiation", irb: "ORA-3" }),
  study({ id: "enr1", title: "Prospective Enrolling", design: "Prospective (Consented)", phase: "Enrolling", irb: "ORA-4",
    enrollTarget: 40, enrollCurrent: 27,
    followUp: [ { id: "f1", label: "6 week", due: 25, done: 24 }, { id: "f2", label: "6 month", due: 15, done: 9 } ] }),
  study({ id: "enr2", title: "Enrolling No Target", design: "Prospective (Consented)", phase: "Enrolling", irb: "ORA-5" }),
  study({ id: "retroEnr", title: "Retro Analysis", design: "Retrospective (Non-Consented)", phase: "Analysis", irb: "ORA-6" }),
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} }, updated_at: now }
];

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items: mockItems }) };
  }
});
const { window } = dom, doc = window.document;
const wait = ms => new Promise(r => setTimeout(r, ms));
const main = () => doc.getElementById("main").innerHTML;

(async () => {
  await wait(420);
  window.eval('upsertProfile("Adam Yanke"); syncOnline = true; worklistPerson = "all"; tab = "worklist"; render();');
  await wait(150);

  console.log("\n-- The old boolean checklist was carried across --");
  const p1 = JSON.parse(window.eval('JSON.stringify(state.studies.find(s=>s.id==="init1").initiationProgress)'));
  check("Coverage analysis came over as Passed", p1.coverage && p1.coverage.status === "Passed", p1);
  check("An IRB submission with no approval reads as Submitted", p1.irb && p1.irb.status === "Submitted", p1.irb);
  check("Untouched stages aren't invented", !p1.redcap);
  check("A study with no old checklist starts empty",
    window.eval('JSON.stringify(state.studies.find(s=>s.id==="init2").initiationProgress)') === "{}");

  console.log("\n-- The six stages are the default and are editable data --");
  const stages = JSON.parse(window.eval("JSON.stringify(initiationStages().map(s=>s.label))"));
  const keys = JSON.parse(window.eval("JSON.stringify(initiationStages().map(s=>s.key))"));
  check("The original six KEYS survived, so recorded dates aren't orphaned",
    ["coverage","irb","contract","piq","redcap","sync"].every(k => keys.includes(k)), keys);
  check("The CRCM's site-activation stages are all there",
    ["feasibility","pcoi","extIrb","coverageFinal","oncore","systems","labs","siv","activation"].every(k => keys.includes(k)), keys);
  check("Feasibility comes first, activation last",
    keys[0] === "feasibility" && keys[keys.length - 1] === "activation", [keys[0], keys[keys.length-1]]);
  check("The list comes from state, so it can grow", window.eval("state.initiationStages") === null);

  console.log("\n-- Layouts are offered in the View dropdown --");
  const sel = doc.getElementById("fs-select-worklist");
  const opts = [...sel.options].map(o => o.value);
  check("Spreadsheet layout offered", opts.includes("__layout_table"));
  check("Initiation layout offered", opts.includes("__layout_initiation"));
  check("Enrolling layout offered", opts.includes("__layout_enrolling"));
  check("Spreadsheet is the default", window.eval("worklistLayout") === "table");

  console.log("\n-- Initiation status layout --");
  sel.value = "__layout_initiation";
  sel.dispatchEvent(new window.Event("change"));
  await wait(150);
  check("Switched layout", window.eval("worklistLayout") === "initiation");
  check("Prospective studies in Initiation are listed", main().includes("Prospective In Initiation") && main().includes("Second Initiation"));
  check("A RETROSPECTIVE study in Initiation is excluded", !main().includes("Retro In Initiation"));
  check("An enrolling study is excluded", !main().includes("Prospective Enrolling"));
  check("Stage columns are rendered", main().includes("Coverage analysis") && main().includes("REDCap build — pediatric assent consent only"));
  check("The CRCM's later stages appear as columns too",
    main().includes("Site Initiation Visit") && main().includes("Site activation"));
  check("Carried-over statuses show", main().includes(">Passed<") && main().includes(">Submitted<"));
  check("A cleared count is shown", /\d+\/\d+/.test(main()));
  check("Each row has an Edit button", main().includes("data-init-edit"));

  console.log("\n-- N/A counts as cleared, not outstanding --");
  // Mark every stage Passed except two set to N/A, so the expectation follows the real list.
  window.eval(`(function(){
    var s = state.studies.find(x=>x.id==="init2");
    var p = {};
    initiationStages().forEach(function(st, i){ p[st.key] = { status: i < 2 ? "N/A" : "Passed" }; });
    s.initiationProgress = p;
  })(); render();`);
  await wait(120);
  const total = window.eval("initiationStages().length");
  const done = JSON.parse(window.eval('JSON.stringify(initiationDone(state.studies.find(s=>s.id==="init2")))'));
  check("N/A stages leave the denominator", done.total === total - 2, { done, total });
  check("...and the study reads fully cleared", done.passed === done.total, done);

  console.log("\n-- Editing stages records both dates --");
  window.eval('openInitiationSheet("init2")');
  await wait(120);
  check("The sheet offers a status per stage", !!doc.getElementById("f-st-coverage") && !!doc.getElementById("f-st-sync"));
  check("...plus submitted and passed dates", !!doc.getElementById("f-sub-irb") && !!doc.getElementById("f-pass-irb"));
  check("N/A is an available status", [...doc.getElementById("f-st-contract").options].some(o => o.value === "N/A"));
  doc.getElementById("f-st-irb").value = "Submitted";
  doc.getElementById("f-sub-irb").value = "2026-08-01";
  doc.getElementById("sheet-save").click();
  await wait(150);
  const saved = JSON.parse(window.eval('JSON.stringify(state.studies.find(s=>s.id==="init2").initiationProgress.irb)'));
  check("Status saved", saved.status === "Submitted", saved);
  check("Submitted date saved", saved.submitted === "2026-08-01", saved);

  console.log("\n-- The stage list is editable, and editing it never drops history --");
  window.eval('upsertProfile("Adam Yanke"); tab = "settings"; render();');
  await wait(150);
  check("Admins get a stage-list editor", !!doc.getElementById("stages-edit"));
  const before = window.eval("initiationStages().length");
  window.eval("openStagesSheet()");
  await wait(150);
  check("The sheet lists every stage", doc.querySelectorAll("[data-stage-row]").length === before,
    doc.querySelectorAll("[data-stage-row]").length);
  // Rename the first stage and add one.
  doc.querySelectorAll(".stage-label")[0].value = "Feasibility (renamed)";
  doc.getElementById("stage-add").click();
  await wait(60);
  const rowsNow = doc.querySelectorAll("[data-stage-row]");
  rowsNow[rowsNow.length - 1].querySelector(".stage-label").value = "Sponsor agreement";
  doc.getElementById("sheet-save").click();
  await wait(200);
  const after = JSON.parse(window.eval("JSON.stringify(initiationStages())"));
  check("The rename stuck", after[0].label === "Feasibility (renamed)", after[0]);
  check("...without changing its key, so history survives", after[0].key === "feasibility", after[0]);
  check("The new stage was added", after.some(st => st.label === "Sponsor agreement"), after.map(a=>a.label));
  check("It synced to the team on the roster record",
    window.eval('!!(sb.__items.find(r=>r.kind==="meta")||{}).data.initiationStages') === true);
  check("Recorded dates are untouched by the list edit",
    window.eval('!!state.studies.find(s=>s.id==="init2").initiationProgress.coverage') === true);

  console.log("\n-- Enrolling summary layout --");
  window.eval('tab = "worklist"; worklistLayout = "enrolling"; render();');
  await wait(150);
  check("Prospective enrolling studies listed", main().includes("Prospective Enrolling"));
  check("A retrospective study is excluded", !main().includes("Retro Analysis"));
  check("An initiation-phase study is excluded", !main().includes("Second Initiation"));
  check("Target and enrolled shown", main().includes("27") && main().includes("40"));
  check("Percent of IRB target shown", main().includes("68% of IRB target"), (main().match(/\d+% of IRB target/) || [])[0]);
  check("Totals across studies are summarised", main().includes("Target (IRB)"));
  check("Follow-up timepoints listed", main().includes("6 week") && main().includes("6 month"));
  check("A lagging timepoint is flagged in orange", /var\(--orange\)/.test(main()));
  check("A study with no target says so rather than showing NaN",
    main().includes("set a target in Edit Study") && !/NaN/.test(main()));
  check("No 'undefined' leaked into the view", !/undefined/.test(main()));

  console.log("\n-- Follow-up maths --");
  const fu = JSON.parse(window.eval('JSON.stringify(followUpTotals(state.studies.find(s=>s.id==="enr1")))'));
  check("Totals add up", fu.due === 40 && fu.done === 33, fu);
  check("Overall percentage rounded", fu.pct === 83, fu.pct);
  const empty = JSON.parse(window.eval('JSON.stringify(followUpTotals(state.studies.find(s=>s.id==="enr2")))'));
  check("No timepoints gives null rather than 0% or NaN", empty.pct === null, empty);

  console.log("\n-- Follow-up editor holds counts, not patients --");
  window.eval('openFollowUpSheet("enr2")');
  await wait(120);
  check("A timepoint row is offered", !!doc.querySelector(".fu-label"));
  check("Due and completed are numeric inputs",
    doc.querySelector(".fu-due").type === "number" && doc.querySelector(".fu-done").type === "number");
  check("It says why it's counts only", doc.getElementById("sheet").innerHTML.includes("outside HIPAA scope"));
  doc.querySelector(".fu-label").value = "1 year";
  doc.querySelector(".fu-due").value = "10";
  doc.querySelector(".fu-done").value = "4";
  doc.getElementById("fu-add").click();
  await wait(60);
  check("Add gives another blank row", doc.querySelectorAll("[data-fu-row]").length === 2);
  doc.getElementById("sheet-save").click();
  await wait(150);
  const saved2 = JSON.parse(window.eval('JSON.stringify(state.studies.find(s=>s.id==="enr2").followUp)'));
  check("Only the filled row was kept", saved2.length === 1, saved2);
  check("...with its numbers", saved2[0].label === "1 year" && saved2[0].due === 10 && saved2[0].done === 4, saved2[0]);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
