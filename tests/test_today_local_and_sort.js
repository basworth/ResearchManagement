// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Two things:
//
// 1. "Today" was computed with toISOString(), which is UTC. In Chicago that means from 7pm local
//    onwards the app already believed it was tomorrow — so a deadline due today dropped into Past
//    Deadlines five hours early, task colours went overdue early, and note dates were wrong. Every
//    date in this app is a calendar date in the user's timezone, never an instant.
// 2. The Stale and Rotten tab sorts longest-neglected first, automatically.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const ago = (n) => new Date(Date.now() - n * 86400000).toISOString();
// Local calendar dates, the same way the app should compute them.
const localDay = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
};

const study = (id, updatedAt) => ({
  id, kind: "study", updated_at: updatedAt,
  data: { id, title: "Study " + id, nickname: id, pi: "Adam Yanke", team: [],
    design: "Prospective (Consented)", phase: "Manuscript", priority: "Medium", irb: "ORA-" + id, milestones: [] }
});
const meeting = (id, deadline, studyIds) => ({
  id, kind: "meeting", updated_at: ago(1),
  data: { id, society: "AANA", name: "Meeting " + id, deadline, type: "abstract", studyIds: studyIds || [], dates: "", link: "" }
});

const mockItems = [
  study("d40", ago(40)),
  study("d19", ago(19)),
  study("d33", ago(33)),
  study("d15", ago(15)),
  study("d3",  ago(3)),
  // A deadline due TODAY must stay on the live board; yesterday's belongs in the archive.
  meeting("dueToday", localDay(0), ["d3"]),
  meeting("dueYesterday", localDay(-1), ["d3"]),
  meeting("dueTomorrow", localDay(1), ["d3"]),
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: ago(1),
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
const rowIds = () => Array.from(doc.querySelectorAll("tr[data-open-study]")).map(r => r.dataset.openStudy);

(async () => {
  await wait(600);
  window.eval('upsertProfile("Adam Yanke"); syncOnline = true;');
  await wait(80);

  console.log("\n-- 'Today' is the user's calendar day, not UTC --");
  check("todayStr() matches the local date", window.eval("todayStr()") === localDay(0),
    [window.eval("todayStr()"), localDay(0)]);
  check("It is NOT built from toISOString",
    !/const todayStr = \(\) => new Date\(\)\.toISOString/.test(html));
  check("Nothing else in the app slices a UTC ISO string for a date",
    (html.match(/toISOString\(\)\.slice\(0, ?10\)/g) || []).length === 0,
    (html.match(/toISOString\(\)\.slice\(0, ?10\)/g) || []));
  check("A date offset helper exists and is local",
    window.eval("dateStrOffset(7)") === localDay(7), [window.eval("dateStrOffset(7)"), localDay(7)]);

  console.log("\n-- daysUntil counts calendar days from today --");
  check("Today is 0", window.eval(`daysUntil(${JSON.stringify(localDay(0))})`) === 0);
  check("Tomorrow is 1", window.eval(`daysUntil(${JSON.stringify(localDay(1))})`) === 1);
  check("Yesterday is -1", window.eval(`daysUntil(${JSON.stringify(localDay(-1))})`) === -1);

  console.log("\n-- A deadline due today has NOT gone past --");
  window.eval('tab = "dashboard"; render();');
  await wait(250);
  const dash = doc.getElementById("main").innerHTML;
  check("Due today is on the live board", !!doc.querySelector('details.dl[data-dl="dueToday"]'));
  check("Due tomorrow is on the live board", !!doc.querySelector('details.dl[data-dl="dueTomorrow"]'));
  check("Due yesterday is NOT on the live board", !doc.querySelector('details.dl[data-dl="dueYesterday"]'));
  check("Due yesterday IS in the archive", dash.indexOf('data-past-meeting="dueYesterday"') > 0);
  check("Due today is NOT in the archive", dash.indexOf('data-past-meeting="dueToday"') < 0);
  check("A task due today isn't coloured overdue",
    window.eval(`dueClass(${JSON.stringify(localDay(0))})`) !== "due-overdue",
    window.eval(`dueClass(${JSON.stringify(localDay(0))})`));
  check("...but yesterday's is", window.eval(`dueClass(${JSON.stringify(localDay(-1))})`) === "due-overdue");
  check("A task due in 3 days reads as due-soon",
    window.eval(`dueClass(${JSON.stringify(localDay(3))})`) === "due-soon");

  console.log("\n-- The Stale and Rotten tab sorts worst-first on entry --");
  window.eval('tab = "worklist"; worklistLayout = "default"; personFilter = "all"; worklistPerson = "all"; render();');
  await wait(250);
  const btn = Array.from(doc.querySelectorAll('.seg button')).find(b => b.dataset.wl === "going");
  check("The button is labelled Stale & Rotten", btn && /Stale & Rotten/.test(btn.textContent), btn && btn.textContent);
  btn.click();
  await wait(250);
  check("Entering the tab sets the staleness sort",
    window.eval("worklistSort.key") === "stale" && window.eval("worklistSort.dir") === -1,
    [window.eval("worklistSort.key"), window.eval("worklistSort.dir")]);
  check("Longest-neglected is first, descending", rowIds().join(",") === "d40,d33,d19,d15", rowIds());
  check("The full name appears above the table",
    doc.getElementById("main").innerHTML.indexOf("Stale and Rotten Studies") > 0);
  check("...and explains the ordering", /Longest-neglected first/.test(doc.getElementById("main").innerHTML));

  console.log("\n-- A column header still overrides it --");
  const nickTh = Array.from(doc.querySelectorAll("th[data-sort]")).find(t => t.dataset.sort === "nickname");
  nickTh.click();
  await wait(250);
  check("Sorting by nickname takes over", window.eval("worklistSort.key") === "nickname");
  check("...and reorders the rows", rowIds().join(",") === "d15,d19,d33,d40", rowIds());
  check("Still only the stale and rotten ones are listed", rowIds().indexOf("d3") < 0);

  console.log("\n-- Leaving the tab drops the hidden sort --");
  Array.from(doc.querySelectorAll('.seg button')).find(b => b.dataset.wl === "going").click();
  await wait(200);
  check("Back to staleness on re-entry", window.eval("worklistSort.key") === "stale");
  Array.from(doc.querySelectorAll('.seg button')).find(b => b.dataset.wl === "active").click();
  await wait(250);
  check("Active view isn't left sorted by a column it doesn't show",
    window.eval("worklistSort.key") === null, window.eval("worklistSort.key"));
  check("...and shows fresh studies again", rowIds().indexOf("d3") >= 0, rowIds());

  console.log("\n-- Filter sets carry the new status, and old ones still load --");
  window.eval('worklistStatus = "going"; render();');
  await wait(150);
  check("Saved as 'Stale and Rotten'",
    window.eval('currentFilters("worklist").status') === "Stale and Rotten",
    window.eval('currentFilters("worklist").status'));
  window.eval('applyFilters("worklist", { status: "Active" });');
  check("Loading Active works", window.eval("worklistStatus") === "active");
  window.eval('applyFilters("worklist", { status: "Stale and Rotten" });');
  check("Loading the new name works", window.eval("worklistStatus") === "going");
  window.eval('applyFilters("worklist", { status: "Going off" });');
  check("A set saved under the OLD name still loads", window.eval("worklistStatus") === "going");
  window.eval('applyFilters("worklist", { status: "All" });');
  check("Loading All works", window.eval("worklistStatus") === "all");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
