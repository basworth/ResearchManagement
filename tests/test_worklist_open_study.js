// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Clicking a study did nothing on the Initiation board and Enrolling summary. Both handlers
// called openStudy() and render() but never set tab = "studies", so render() just redrew the
// Worklist — and the study was left silently "open", which then hijacked the next visit to the
// Studies tab. Only the default table set the tab. Every layout must behave the same.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
};

const mk = (id, phase, extra) => ({ id, kind: "study", updated_at: now, data: Object.assign({
  id, title: "Study " + id, nickname: id, pi: "Adam Yanke", team: [],
  design: "Prospective (Consented)", phase, priority: "Medium", irb: "ORA-" + id, milestones: []
}, extra || {}) });

const mockItems = [
  // One study per layout, so each layout has something to click.
  mk("initA", "Initiation", {
    initiationProgress: { irb: { status: "Submitted", submitted: day(-20) } }
  }),
  mk("enrollA", "Enrolling", { enrollTarget: 100, enrollCurrent: 40, irbExpiry: day(200) }),
  mk("manuA", "Manuscript"),
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
    data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} } }
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

const showWorklist = async (layout) => {
  window.eval(`tab = "worklist"; detailStudyId = null; worklistLayout = ${JSON.stringify(layout)};
    worklistStatus = "all"; personFilter = "all"; worklistPerson = "all";
    worklistPhaseFilter = "All phases"; worklistDesignFilter = "All designs";
    worklistSearchQuery = ""; worklistSort = { key: null, dir: 1 }; render();`);
  await wait(240);
};

(async () => {
  await wait(600);
  window.eval('upsertProfile("Adam Yanke"); syncOnline = true;');
  await wait(80);

  for (const layout of ["default", "initiation", "enrolling"]) {
    console.log(`\n-- ${layout} layout --`);
    await showWorklist(layout);
    const targets = Array.from(doc.querySelectorAll("[data-open-study]"));
    check("Studies are listed to click", targets.length > 0, targets.length);
    if (!targets.length) continue;

    const wantId = targets[0].dataset.openStudy;
    check("Starts on the worklist with nothing open",
      window.eval("tab") === "worklist" && window.eval("detailStudyId") === null,
      [window.eval("tab"), window.eval("detailStudyId")]);

    targets[0].click();
    await wait(260);
    check("The click switches to the study page", window.eval("tab") === "studies",
      window.eval("tab"));
    check("...opening the study that was clicked", window.eval("detailStudyId") === wantId,
      [window.eval("detailStudyId"), wantId]);
    check("...and the study page actually renders",
      doc.getElementById("main").innerHTML.indexOf("Edit Study") > 0);
    check("...showing that study's name",
      doc.getElementById("main").innerHTML.indexOf(wantId) > 0);
  }

  console.log("\n-- Going back returns to the layout you came from --");
  await showWorklist("enrolling");
  doc.querySelector("[data-open-study]").click();
  await wait(260);
  check("On a study page", window.eval("tab") === "studies");
  doc.getElementById("back-btn").click();
  await wait(260);
  check("Back lands on the studies list, not a dead end",
    window.eval("detailStudyId") === null, window.eval("detailStudyId"));
  check("The Enrolling layout choice is remembered for next time",
    window.eval("worklistLayout") === "enrolling", window.eval("worklistLayout"));

  console.log("\n-- No study is left 'open' behind the scenes --");
  // The old bug's second half: detailStudyId stayed set while the tab stayed on worklist, so
  // simply tapping Studies later dropped you into a study you thought you'd never opened.
  await showWorklist("initiation");
  check("Nothing open after rendering the board", window.eval("detailStudyId") === null);
  window.eval('tab = "studies"; render();');
  await wait(240);
  check("Switching to Studies shows the LIST, not a hijacked detail page",
    doc.getElementById("main").innerHTML.indexOf("Edit Study") < 0);


  console.log("\n-- Initiation stage rows are tappable, on the study page --");
  window.eval('tab = "studies"; openStudy("initA"); render();');
  await wait(260);
  const stageRows = Array.from(doc.querySelectorAll("[data-init-stage]"));
  check("Stage rows carry a handle", stageRows.length > 0, stageRows.length);
  check("...and look clickable", stageRows[0].style.cursor === "pointer", stageRows[0].style.cursor);
  check("The Edit button is still there as well", !!doc.querySelector("[data-init-edit]"));

  // Tap the IRB row specifically and confirm the sheet opens focused on that stage.
  const irbRow = stageRows.find(r => /\|irb$/.test(r.dataset.initStage));
  check("The IRB stage row is present", !!irbRow, stageRows.map(r => r.dataset.initStage));
  irbRow.click();
  await wait(300);
  check("Tapping a stage opens the editor", !!doc.getElementById("sheet"));
  check("...with a field for that stage", !!doc.getElementById("f-st-irb"));
  check("...and every other stage still editable in the same sheet",
    !!doc.getElementById("f-st-coverage") && !!doc.getElementById("f-st-activation"));
  check("...scrolled to the stage that was tapped",
    !!doc.querySelector('[data-stage-group="irb"]'));
  doc.getElementById("sheet-cancel").click();
  await wait(420);

  console.log("\n-- ...and on the Initiation board, per cell --");
  await showWorklist("initiation");
  const cells = Array.from(doc.querySelectorAll("td[data-init-stage]"));
  check("Every stage cell is tappable", cells.length > 0, cells.length);
  const coverageCell = cells.find(c => /\|coverage$/.test(c.dataset.initStage));
  check("The coverage cell is there", !!coverageCell);
  coverageCell.click();
  await wait(300);
  check("It opens the editor", !!doc.getElementById("sheet"));
  check("...at the coverage stage", !!doc.querySelector('[data-stage-group="coverage"]'));
  check("...and did NOT also navigate to the study page",
    window.eval("tab") === "worklist", window.eval("tab"));
  doc.getElementById("sheet-cancel").click();
  await wait(420);

  console.log("\n-- The study-name cell still navigates, and the Edit button still works --");
  await showWorklist("initiation");
  doc.querySelector("[data-init-edit]").click();
  await wait(300);
  check("Edit opens the full sheet", !!doc.getElementById("sheet") && !!doc.getElementById("f-st-irb"));
  check("...without navigating away", window.eval("tab") === "worklist");
  doc.getElementById("sheet-cancel").click();
  await wait(420);
  await showWorklist("initiation");
  doc.querySelector("td[data-open-study]").click();
  await wait(260);
  check("The name cell still opens the study", window.eval("tab") === "studies");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
