// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// A study nobody has touched in a fortnight has usually been forgotten rather than finished. Two
// weeks tints the Worklist row yellow and tags it STALE; four weeks goes mouldy green, ROTTEN, and
// gets stink lines. On Hold and Published are exempt — parked on purpose isn't forgotten.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
// `ago(n)` = an updated_at timestamp n days in the past.
const ago = (n) => new Date(Date.now() - n * 86400000).toISOString();

// updatedAt drives freshness; it's the Supabase row timestamp, not a field on the study.
const study = (id, phase, updatedAt, extra) => ({
  id, kind: "study", updated_at: updatedAt,
  data: Object.assign({
    id, title: "Study " + id, nickname: "NICK-" + id, pi: "Adam Yanke", team: [],
    design: "Prospective (Consented)", phase, priority: "Medium", irb: "ORA-" + id, milestones: []
  }, extra || {})
});
const task = (id, studyId, updatedAt) => ({
  id, kind: "task", updated_at: updatedAt,
  data: { id, studyId, title: "Task " + id, assignees: ["Adam Yanke"], done: false, due: "" }
});

const mockItems = [
  study("fresh",   "Manuscript", ago(2)),
  study("edge13",  "Manuscript", ago(13)),
  study("stale14", "Manuscript", ago(14)),
  study("stale20", "Analysis",   ago(20)),
  study("edge27",  "Manuscript", ago(27)),
  study("rotten28","Manuscript", ago(28)),
  study("rotten60","Enrolling",  ago(60)),
  study("held",    "On Hold",    ago(120)),
  study("published","Published", ago(400)),
  // Study record is ancient, but someone ticked a task on it yesterday — that's work on the study.
  study("taskonly","Manuscript", ago(90)),
  task("t1", "taskonly", ago(1)),
  // A task belonging to a DIFFERENT study must not rescue this one.
  study("notmine", "Manuscript", ago(50)),
  task("t2", "someone-else", ago(1)),
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
const level = (id) => window.eval(`(function(){ var f = freshness(studyById(${JSON.stringify(id)})); return f ? f.level : null; })()`);
const rowOf = (id) => doc.querySelector(`tr[data-open-study="${id}"]`);

(async () => {
  await wait(600);
  window.eval('upsertProfile("Adam Yanke"); syncOnline = true;');
  await wait(80);

  console.log("\n-- The thresholds land exactly where they should --");
  check("2 days is fresh", level("fresh") === "fresh", level("fresh"));
  check("13 days is still fresh", level("edge13") === "fresh", level("edge13"));
  check("14 days is stale", level("stale14") === "stale", level("stale14"));
  check("20 days is stale", level("stale20") === "stale", level("stale20"));
  check("27 days is still only stale", level("edge27") === "stale", level("edge27"));
  check("28 days is rotten", level("rotten28") === "rotten", level("rotten28"));
  check("60 days is rotten", level("rotten60") === "rotten", level("rotten60"));

  console.log("\n-- Parked on purpose is not the same as forgotten --");
  check("On Hold is exempt however old", level("held") === null, level("held"));
  check("Published is exempt however old", level("published") === null, level("published"));

  console.log("\n-- Work on a task counts as work on the study --");
  check("A 90-day-old study with a task touched yesterday is fresh",
    level("taskonly") === "fresh", level("taskonly"));
  check("...and a task on a DIFFERENT study doesn't rescue it",
    level("notmine") === "rotten", level("notmine"));

  console.log("\n-- No timestamp means unknown, not ancient --");
  check("A study Team Sync has never seen isn't flagged",
    window.eval('freshness({ id: "never-synced", phase: "Manuscript" })') === null);

  console.log("\n-- The Worklist tints and tags the rows --");
  window.eval('tab = "worklist"; worklistLayout = "default"; personFilter = "all"; worklistPerson = "all"; worklistStatus = "all"; render();');
  await wait(250);
  check("Rows rendered", !!rowOf("stale20") && !!rowOf("rotten60") && !!rowOf("fresh"));
  check("A fresh row carries no tint class", rowOf("fresh").className === "", rowOf("fresh").className);
  check("A stale row is tinted yellow", rowOf("stale20").className === "wl-stale", rowOf("stale20").className);
  check("A rotten row is tinted mouldy", rowOf("rotten60").className === "wl-rotten", rowOf("rotten60").className);
  check("On Hold gets no tint", rowOf("held").className === "", rowOf("held").className);
  check("Published gets no tint", rowOf("published").className === "", rowOf("published").className);

  check("The stale row is tagged with its age", /STALE · 20d/.test(rowOf("stale20").innerHTML), (rowOf("stale20").innerHTML.match(/STALE[^<]*/) || [])[0]);
  check("The rotten row says ROTTEN", /ROTTEN · 60d/.test(rowOf("rotten60").innerHTML), (rowOf("rotten60").innerHTML.match(/ROTTEN[^<]*/) || [])[0]);
  check("A fresh row is tagged with neither", !/STALE|ROTTEN/.test(rowOf("fresh").innerHTML));

  console.log("\n-- It smells --");
  const stink = rowOf("rotten60").querySelector(".stink");
  check("The rotten row has stink lines", !!stink);
  check("...three of them", stink && stink.querySelectorAll("span").length === 3,
    stink && stink.querySelectorAll("span").length);
  check("...hidden from screen readers, since it's decoration",
    stink && stink.getAttribute("aria-hidden") === "true");
  check("A merely stale row does NOT smell yet", !rowOf("stale20").querySelector(".stink"));
  check("The animation is defined", html.indexOf("@keyframes stink-rise") > 0);
  check("...and switched off for reduced-motion users",
    /prefers-reduced-motion[\s\S]{0,120}\.stink span \{ animation: none/.test(html));

  console.log("\n-- The tag keeps the row readable rather than shouting over it --");
  check("Mould green is not the app's success green",
    html.indexOf("wl-rotten td { background: color-mix(in srgb, #6b8e23") > 0);
  check("The tint is a low-opacity mix, so text stays legible",
    /wl-stale td \{ background: color-mix\(in srgb, #e8b400 16%/.test(html));

  console.log("\n-- The footnote counts them up --");
  const foot = doc.getElementById("main").innerHTML;
  // rotten28, rotten60 and notmine (50d) = 3; stale14, stale20 and edge27 = 3.
  check("It reports the rotten count", /3 rotten/.test(foot), (foot.match(/\d+ rotten/) || [])[0]);
  check("...and the stale count", /3 stale/.test(foot), (foot.match(/\d+ stale/) || [])[0]);
  check("...and explains the exemption", /On Hold and Published studies are exempt/.test(foot));

  console.log("\n-- A clean board says so, rather than staying silent --");
  window.eval(`(function(){
    Object.keys(remoteMeta).forEach(function(k){ remoteMeta[k].updated_at = ${JSON.stringify(ago(1))}; });
  })(); render();`);
  await wait(250);
  const foot2 = doc.getElementById("main").innerHTML;
  check("Says nothing has gone off", /Nothing on this list has gone off/.test(foot2));
  check("...and no row is tinted", !/wl-stale|wl-rotten/.test(foot2));

  console.log("\n-- Touching a study clears it --");
  window.eval(`(function(){
    remoteMeta["rotten60"].updated_at = ${JSON.stringify(ago(40))};
  })(); render();`);
  await wait(200);
  check("Back to rotten when the timestamp goes back", rowOf("rotten60").className === "wl-rotten");
  window.eval(`(function(){
    remoteMeta["rotten60"].updated_at = ${JSON.stringify(ago(0))};
  })(); render();`);
  await wait(200);
  check("Saving it today clears the tint entirely", rowOf("rotten60").className === "");
  check("...and removes the smell", !rowOf("rotten60").querySelector(".stink"));


  console.log("\n-- The Going off filter --");
  // Earlier blocks deliberately reset every timestamp, so put the original ages back first.
  const originalAges = {};
  mockItems.forEach(it => { originalAges[it.id] = it.updated_at; });
  window.eval(`(function(){
    var orig = ${JSON.stringify(originalAges)};
    Object.keys(orig).forEach(function(k){ if (remoteMeta[k]) remoteMeta[k].updated_at = orig[k]; });
  })();`);
  window.eval('worklistStatus = "going"; render();');
  await wait(250);
  const goingRows = Array.from(doc.querySelectorAll("tr[data-open-study]")).map(r => r.dataset.openStudy).sort();
  check("Shows only stale and rotten studies",
    goingRows.join(",") === "edge27,notmine,rotten28,rotten60,stale14,stale20", goingRows);
  check("Fresh studies are excluded", goingRows.indexOf("fresh") < 0);
  check("On Hold is excluded even though it's ancient", goingRows.indexOf("held") < 0);
  check("Published is excluded even though it's ancient", goingRows.indexOf("published") < 0);
  check("A study kept alive by a recent task is excluded", goingRows.indexOf("taskonly") < 0);

  window.eval('worklistStatus = "active"; render();');
  await wait(250);
  const activeRows = Array.from(doc.querySelectorAll("tr[data-open-study]")).map(r => r.dataset.openStudy);
  check("Active still shows fresh ones too", activeRows.indexOf("fresh") >= 0);
  check("...and still excludes On Hold", activeRows.indexOf("held") < 0);

  window.eval('worklistStatus = "all"; render();');
  await wait(250);
  const allRows = Array.from(doc.querySelectorAll("tr[data-open-study]")).map(r => r.dataset.openStudy);
  check("All includes On Hold and Published", allRows.indexOf("held") >= 0 && allRows.indexOf("published") >= 0);

  console.log("\n-- The three buttons are wired up --");
  window.eval('worklistStatus = "going"; render();');
  await wait(200);
  const segs = Array.from(doc.querySelectorAll(".seg button")).map(b => [b.dataset.wl, b.className]);
  check("Three segments offered", segs.length === 3, segs);
  check("...in the order Active, Going off, All",
    segs.map(x => x[0]).join(",") === "active,going,all", segs.map(x => x[0]));
  check("The current one is marked", segs.find(x => x[0] === "going")[1] === "active", segs);

  console.log("\n-- An empty Going off list says so cheerfully --");
  window.eval(`(function(){
    Object.keys(remoteMeta).forEach(function(k){ remoteMeta[k].updated_at = ${JSON.stringify(ago(1))}; });
  })(); worklistStatus = "going"; render();`);
  await wait(250);
  const emptyHTML = doc.getElementById("main").innerHTML;
  check("Says nothing is stale or rotten", /Nothing is stale or rotten/.test(emptyHTML));
  check("...and not the generic 'no studies yet'", !/No active studies yet/.test(emptyHTML));

  console.log("\n-- Quiet-but-not-stale rows show their age --");
  window.eval(`(function(){
    remoteMeta["fresh"].updated_at = ${JSON.stringify(ago(9))};
    remoteMeta["edge13"].updated_at = ${JSON.stringify(ago(3))};
  })(); worklistStatus = "active"; render();`);
  await wait(250);
  check("A 9-day-old study is labelled quiet", /quiet 9d/.test(rowOf("fresh").innerHTML),
    (rowOf("fresh").innerHTML.match(/quiet \d+d/) || [])[0]);
  check("...but not tinted", rowOf("fresh").className === "", rowOf("fresh").className);
  check("A 3-day-old study stays clean", !/quiet/.test(rowOf("edge13").innerHTML));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
