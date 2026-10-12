// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// The ICRS regression of 7 Oct 2026: three studies were tagged for the ICRS congress at 17:30,
// and 34 minutes later the meeting row came back with studyIds: []. The tagging tasks survived.
//
// Two defences are tested here:
//   1. a stale client can no longer shrink a meeting's studyIds (pushMeeting merges)
//   2. links already lost are rebuilt from the surviving submission tasks on load
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const MTG = "mtg-icrs";
const S1 = "study-fea", S2 = "study-ssm", S3 = "study-troch";
const now = new Date().toISOString();
const study = (id, title) => ({ id, kind: "study", updated_at: now, data: {
  id, title, design: "Prospective (Consented)", phase: "Analysis", priority: "Medium" } });
const task = (id, studyId) => ({ id, kind: "task", updated_at: now, data: {
  id, title: "Submit abstract: 19th World Congress", studyId, due: "2026-10-15",
  assignees: [], notes: "Auto-linked to ICRS — 19th World Congress.", done: false, linkedMeetingId: MTG } });

// The meeting as the live database actually held it afterwards: links gone, tasks intact.
const mockItems = [
  study(S1, "FEA — Patellofemoral joint contact pressures"),
  study(S2, "Bone Shape as an Independent Risk Factor"),
  study(S3, "Cartilage Health Following Recession Wedge Trochleoplasty"),
  task("t1", S1), task("t2", S2), task("t3", S3),
  { id: MTG, kind: "meeting", updated_at: now, data: {
    id: MTG, key: "ICRS|19th World Congress", society: "ICRS", name: "19th World Congress",
    type: "abstract", deadline: "2026-10-15", dates: "", location: "Rotterdam, NL", link: "",
    aim: "", criteria: "", funded: [], studyIds: [], unconfirmed: false, verifiedOn: "2026-10-01T09:30" } }
];

const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items: mockItems }) };
  }
});
const { window } = dom;
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}

(async () => {
  await wait(400);
  // `state` and the helpers are script-scoped consts, so they aren't window properties — reach
  // them the way the other tests do, through the page's own eval.
  const ev = (code) => window.eval(code);
  const mtgIds = () => ev(`JSON.stringify(state.meetings.find(x => x.id === ${JSON.stringify(MTG)}).studyIds)`);

  console.log("\n-- Links lost by an older build are rebuilt from their tasks --");
  const ids = JSON.parse(mtgIds());
  check("all three studies are linked again", ids.length === 3, ids);
  check("each one specifically", [S1, S2, S3].every(id => ids.includes(id)), ids);
  check("the meeting shows on a study page",
    ev(`meetingsForStudy(${JSON.stringify(S2)}).some(x => x.id === ${JSON.stringify(MTG)})`));

  console.log("\n-- It only ever adds --");
  const beforeIds = mtgIds();
  ev("healMeetingLinksFromTasks()");
  check("running it again changes nothing", mtgIds() === beforeIds, mtgIds());
  // A task pointing at a study that no longer exists must not invent a link.
  ev(`state.tasks.push({ id: "t-ghost", title: "Submit abstract: 19th World Congress",
    studyId: "deleted-study", due: "", assignees: [], notes: "", done: false,
    linkedMeetingId: ${JSON.stringify(MTG)} }); healMeetingLinksFromTasks();`);
  check("a task for a deleted study adds nothing", !mtgIds().includes("deleted-study"), mtgIds());
  ev(`state.tasks = state.tasks.filter(t => t.id !== "t-ghost")`);

  console.log("\n-- A stale client can no longer wipe the links --");
  // Exactly the losing write: a copy of the meeting that predates the tagging, pushed by a
  // deadline refresh. Its studyIds are empty; the server's are not.
  ev(`window.__stale = JSON.parse(JSON.stringify(state.meetings.find(x => x.id === ${JSON.stringify(MTG)})));
      window.__stale.studyIds = [];
      window.__stale.dates = "May 1-3, 2027, Rotterdam (refreshed)";
      window.__done = pushMeeting(window.__stale, false);`);
  await window.__done;
  await wait(100);
  check("the refresh kept all three links", (window.__stale.studyIds || []).length === 3, window.__stale.studyIds);
  check("...and still applied its own update", window.__stale.dates.includes("refreshed"));

  console.log("\n-- Unlinking on purpose still works --");
  ev(`toggleStudyLink(${JSON.stringify(MTG)}, ${JSON.stringify(S1)})`);
  await wait(150);
  check("the study is unlinked", !mtgIds().includes(S1), mtgIds());
  check("...and its submission task is gone too",
    !ev(`state.tasks.some(t => t.linkedMeetingId === ${JSON.stringify(MTG)} && t.studyId === ${JSON.stringify(S1)})`));
  ev("healMeetingLinksFromTasks()");
  check("...and the self-heal does not undo the unlink", !mtgIds().includes(S1), mtgIds());

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
