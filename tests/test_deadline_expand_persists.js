// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Tapping a linked project under a meeting used to open the study but collapse the meeting,
// because <details> keeps its open state in the DOM only and every render() rebuilt the board.
// Coming back meant hunting for the meeting again. Expansion is now remembered.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

const study = (id, title) => ({ id, kind: "study", data: {
  id, title, nickname: title, pi: "Adam Yanke", team: [], design: "Prospective (Consented)",
  phase: "Manuscript", priority: "Medium", irb: "ORA-" + id, milestones: []
}, updated_at: now });

const meeting = (id, society, name, deadline, studyIds) => ({ id, kind: "meeting", data: {
  id, society, name, deadline, type: "abstract", studyIds: studyIds || [], dates: "", link: ""
}, updated_at: now });

const mockItems = [
  study("s1", "ACL Registry"),
  study("s2", "MPFL RCT"),
  meeting("m1", "AANA", "AANA 2027 Annual Meeting", day(40), ["s1", "s2"]),
  meeting("m2", "AOSSM", "AOSSM 2027 Annual Meeting", day(70), ["s1"]),
  meeting("m3", "ORS", "ORS 2027 Annual Meeting", day(95), []),
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta",
    data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} }, updated_at: now }
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
const row = (id) => doc.querySelector(`details.dl[data-dl="${id}"]`);
const isOpen = (id) => { const d = row(id); return !!d && d.open; };
// jsdom fires `toggle` for a programmatic `open` change, same as a real click on the summary.
const setOpen = async (id, v) => { const d = row(id); d.open = v; await wait(40); };

(async () => {
  await wait(500);
  window.eval('upsertProfile("Adam Yanke"); syncOnline = true; tab = "dashboard"; render();');
  await wait(200);

  console.log("\n-- The board starts collapsed --");
  check("Meeting rows are rendered", !!row("m1") && !!row("m2") && !!row("m3"));
  check("...all closed to begin with", !isOpen("m1") && !isOpen("m2") && !isOpen("m3"));
  check("Each row is tagged with its meeting id", row("m1").dataset.dl === "m1");

  console.log("\n-- Expanding survives a re-render --");
  await setOpen("m1", true);
  check("Opening it registers", isOpen("m1"));
  window.eval("render();");
  await wait(150);
  check("...and it's still open after a re-render", isOpen("m1"));
  check("...while its neighbours stay closed", !isOpen("m2") && !isOpen("m3"));

  console.log("\n-- Collapsing sticks too, rather than springing back --");
  await setOpen("m1", false);
  window.eval("render();");
  await wait(150);
  check("Closed stays closed", !isOpen("m1"));

  console.log("\n-- Tapping a linked project opens the study AND keeps the meeting open --");
  await setOpen("m1", true);
  const chip = row("m1").querySelector('[data-open-study="s2"]');
  check("The project chip is inside the expanded meeting", !!chip);
  chip.click();
  await wait(200);
  check("It navigated to the study", window.eval("tab") === "studies" && window.eval("detailStudyId") === "s2",
    [window.eval("tab"), window.eval("detailStudyId")]);
  check("The study page is showing", doc.getElementById("main").innerHTML.indexOf("MPFL RCT") > 0);

  window.eval('tab = "dashboard"; detailStudyId = null; render();');
  await wait(200);
  check("Back on the dashboard, that meeting is STILL expanded", isOpen("m1"));
  check("...and the others are still closed", !isOpen("m2") && !isOpen("m3"));
  check("...with the project list visible without another tap",
    !!row("m1").querySelector('[data-open-study="s2"]'));

  console.log("\n-- Resetting the memory really does clear it --");
  window.eval('openDeadlines = {}; render();');
  await wait(150);
  check("Everything closes again", !isOpen("m1") && !isOpen("m2") && !isOpen("m3"));

  console.log("\n-- A second meeting is remembered independently --");
  await setOpen("m2", true);
  row("m2").querySelector('[data-open-study="s1"]').click();
  await wait(200);
  window.eval('tab = "dashboard"; detailStudyId = null; render();');
  await wait(200);
  check("m2 is remembered after the round trip", isOpen("m2"));
  check("m1 is not, because the memory was cleared", !isOpen("m1"));

  console.log("\n-- Two rows can be open at once --");
  await setOpen("m1", true);
  window.eval("render();");
  await wait(150);
  check("Both m1 and m2 open", isOpen("m1") && isOpen("m2"));
  check("m3, never touched, is still closed", !isOpen("m3"));
  const openIds = Object.keys(JSON.parse(window.eval("JSON.stringify(openDeadlines)"))).sort();
  check("The remembered set is exactly those two", openIds.join(",") === "m1,m2", openIds);

  console.log("\n-- Nothing is lost when a meeting disappears from the board --");
  // A remembered id for a meeting that's since been hidden or deleted must not throw.
  window.eval('openDeadlines["nonexistent-meeting"] = true; render();');
  await wait(150);
  check("The board still renders", !!row("m1"));
  check("...and the real rows keep their state", isOpen("m1") && isOpen("m2"));

  console.log("\n-- The Past Deadlines archive keeps its own separate memory --");
  window.eval(`(function(){
    var m = state.meetings.find(x => x.id === "m3");
    m.deadline = ${JSON.stringify(day(-30))};
    m.studyIds = ["s1"];
  })(); render();`);
  await wait(200);
  const pastToggle = doc.querySelector("[data-past-toggle]");
  check("There's a Past Deadlines section now", !!pastToggle);
  if (pastToggle) {
    pastToggle.click();
    await wait(120);
    const pastHeader = doc.querySelector('[data-past-meeting="m3"]');
    check("The lapsed meeting is listed in the archive", !!pastHeader);
    if (pastHeader) {
      pastHeader.click();
      await wait(120);
      const pastChip = doc.querySelector('[data-past-meeting-body="m3"] [data-open-study="s1"]');
      check("Its submission is reachable", !!pastChip);
      pastChip.click();
      await wait(200);
      check("Clicking it opens the study", window.eval("detailStudyId") === "s1", window.eval("detailStudyId"));
      window.eval('tab = "dashboard"; detailStudyId = null; render();');
      await wait(200);
      check("The archive remembers it was expanded", window.eval('!!pastMeetingOpen["m3"]'));
      check("...and the live board's memory is untouched", isOpen("m1"));
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
