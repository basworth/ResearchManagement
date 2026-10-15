// Blocker 2 of the multi-lab work, 15 Oct 2026.
//
// Study→deadline tags used to live in `meeting.studyIds`. The meeting record is the ONE thing
// every lab shares on purpose — a single deadline calendar — so every lab's tags sat in a row the
// other labs could read and overwrite. With one lab that was a race (it cost three ICRS tags on
// 7 Oct). With Kern Singh's lab arriving it becomes a leak.
//
// Tags now live in their own `mtgTag` records, one per lab per deadline, sealed by the same
// database rules as studies and tasks. This file holds that to four promises:
//
//   1. the existing links migrate into a tag record, once
//   2. another lab's ids in the shared legacy field never cross into this lab's view
//   3. the legacy field is never shrunk — nothing is deleted, only ignored
//   4. an unlink survives a pull (the legacy field must not resurrect it)
//
// (4) is the one worth the trouble: seeding from the legacy field on every load, rather than once,
// would make unlinking impossible to make stick, and it would look exactly like a sync bug.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const MTG = "mtg-icrs";
const MINE = "study-mine";
// A spine study. Real RLS means its own row is simply not readable here, so the only trace of it
// this lab can ever see is its id sitting in the shared meeting's legacy list.
const THEIRS = "study-spine-1";
const now = new Date().toISOString();

const mockItems = [
  { id: MINE, kind: "study", updated_at: now, workspace: "sports-yanke", data: {
    id: MINE, title: "Bone Shape as an Independent Risk Factor",
    design: "Prospective (Consented)", phase: "Analysis", priority: "Medium" } },
  { id: MTG, kind: "meeting", updated_at: now, workspace: "sports-yanke", data: {
    id: MTG, key: "ICRS|19th World Congress", society: "ICRS", name: "19th World Congress",
    type: "abstract", deadline: "2026-10-22", dates: "", location: "Rotterdam, NL", link: "",
    aim: "", criteria: "", funded: [], studyIds: [MINE, THEIRS],
    unconfirmed: false, verifiedOn: "2026-10-01T09:30" } }
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
const serverRow = (id) => mockItems.find(r => r.id === id);

(async () => {
  await wait(500);
  const ev = (code) => window.eval(code);
  const mtgIds = () => JSON.parse(ev(`JSON.stringify(state.meetings.find(x => x.id === ${JSON.stringify(MTG)}).studyIds)`));
  const tag = () => JSON.parse(ev(`JSON.stringify(state.mtgTags.find(t => t.meetingId === ${JSON.stringify(MTG)}) || null)`));

  console.log("\n-- The existing link migrates into a tag record --");
  check("a tag record exists for the deadline", !!tag(), tag());
  check("it carries my study", (tag() && tag().studyIds || []).includes(MINE), tag());
  check("it is a separate row, not the meeting's", tag() && tag().id !== MTG, tag() && tag().id);
  const tagRow = mockItems.find(r => r.kind === "mtgTag");
  check("and it was written to its own mtgTag row", !!tagRow, tagRow && tagRow.id);
  check("stamped with this lab", tagRow && tagRow.workspace === "sports-yanke", tagRow && tagRow.workspace);

  console.log("\n-- Another lab's id never crosses into this lab's view --");
  check("the spine study is not in my links", !mtgIds().includes(THEIRS), mtgIds());
  check("...nor in my tag record", !(tag().studyIds || []).includes(THEIRS), tag());
  check("only my study is linked", mtgIds().length === 1 && mtgIds()[0] === MINE, mtgIds());

  console.log("\n-- The shared legacy field is never shrunk --");
  // Nothing removes data: the old field keeps both ids, it is simply no longer read.
  ev(`window.__m = state.meetings.find(x => x.id === ${JSON.stringify(MTG)});
      window.__m.dates = "May 1-3, 2027 (refreshed)";
      window.__done = pushMeeting(window.__m);`);
  await window.__done;
  await wait(100);
  const after = serverRow(MTG).data;
  check("the spine id survived the write", (after.studyIds || []).includes(THEIRS), after.studyIds);
  check("...and so did mine", (after.studyIds || []).includes(MINE), after.studyIds);
  check("...and the refresh still applied", after.dates.includes("refreshed"), after.dates);
  check("my own view is still only my study", mtgIds().length === 1, mtgIds());

  console.log("\n-- An unlink survives a pull --");
  // The regression this guards: the legacy field still names my study, so re-seeding on every
  // load would quietly put the link back and the unlink would look like it never saved.
  ev(`toggleStudyLink(${JSON.stringify(MTG)}, ${JSON.stringify(MINE)})`);
  await wait(200);
  check("unlinked locally", mtgIds().length === 0, mtgIds());
  check("...and the tag record says so", (tag().studyIds || []).length === 0, tag());
  ev(`window.__pull = pullAll()`);
  await window.__pull;
  await wait(200);
  check("still unlinked after a full pull", mtgIds().length === 0, mtgIds());
  check("...and the legacy field still names both, untouched",
    (serverRow(MTG).data.studyIds || []).length === 2, serverRow(MTG).data.studyIds);

  console.log("\n-- Re-linking writes the tag record, not the meeting --");
  const meetingUpdatedAt = serverRow(MTG).updated_at;
  ev(`toggleStudyLink(${JSON.stringify(MTG)}, ${JSON.stringify(MINE)})`);
  await wait(200);
  check("linked again", mtgIds().includes(MINE), mtgIds());
  check("the tag row carries it", (mockItems.find(r => r.kind === "mtgTag").data.studyIds || []).includes(MINE));
  check("the shared meeting row was not rewritten", serverRow(MTG).updated_at === meetingUpdatedAt);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
