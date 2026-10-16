// The roster stops being shared between labs — 16 Oct 2026.
//
// Found while answering "is it ready to send to Kern?". The answer was no, and this was the worst
// of the three reasons: `meta` sat in the shared commons next to the deadline calendar, and it
// carries the team roster, everyone's degrees, the name-alias map and the lab's initiation
// checklist. A second lab would have opened the app to find the first lab's seventeen people in
// its roster and its task-assignment pickers.
//
// The visibility was only half of it. There was ONE meta row and the app writes it whole, so two
// labs editing their team lists would have taken turns deleting each other's.
//
// What's held here:
//   * each lab writes to its own row, derived from its workspace name
//   * the ORIGINAL lab keeps the id its row has always had, so nothing has to be copied
//   * a lab with no roster row yet gets an empty roster, not the last lab's names
//   * the deadline calendar is still shared — that part was always right
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
// The migration files live in Adam's workspace folder and aren't published to the repo, so in CI
// there is nothing to read. Only the SQL assertions depend on them — the behaviour checks above
// don't, and skipping the whole file to avoid one missing .sql would throw away the part that
// actually exercises the app.
const SQL_DIR = require("path").join(PROJECT, "supabase", "migrations");
const haveSql = fs.existsSync(SQL_DIR);


const USER = "test-user-1";
const ROSTER_ID = "00000000-0000-0000-0000-000000000001";
const now = new Date().toISOString();

const profile = (ws) => ({
  id: USER, kind: "profile", updated_at: now, workspace: ws,
  data: { id: USER, email: "test@example.com", name: "Alex Rivera", position: "Clinician",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true, tourSeen: 1, linkedTo: "" },
});
const metaRow = (id, ws, names) => ({
  id, kind: "meta", updated_at: now, workspace: ws,
  data: { id, names, degrees: {}, orgPermissions: false, initiationStages: null,
    nameAliases: {}, stageAdds: [] },
});
const meeting = () => ({
  id: "m1", kind: "meeting", updated_at: now, workspace: "sports-yanke",
  data: { id: "m1", key: "ICRS|19th", society: "ICRS", name: "19th World Congress", type: "abstract",
    deadline: "2027-01-20", dates: "", location: "", link: "", aim: "", criteria: "", funded: [],
    studyIds: [], unconfirmed: false, verifiedOn: "2026-10-01T09:00" },
});

function boot(items) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items }) };
    },
  });
  return dom.window;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}

(async () => {
  console.log("\n-- The original lab keeps the row it has always had --");
  const yanke = [profile("sports-yanke"), metaRow(ROSTER_ID, "sports-yanke", ["Adam Yanke", "Carla Edwards"]), meeting()];
  const w = boot(yanke);
  await wait(600);
  const ev = (c) => w.eval(c);
  check("its row id is unchanged", ev(`metaRowId("sports-yanke")`) === ROSTER_ID, ev(`metaRowId("sports-yanke")`));
  check("...and an empty workspace falls back to it too", ev(`metaRowId("")`) === ROSTER_ID);
  check("the roster loaded", JSON.parse(ev("JSON.stringify(state.roster)")).length === 2, ev("JSON.stringify(state.roster)"));

  console.log("\n-- A second lab gets its own row, not that one --");
  const spineId = ev(`metaRowId("spine-singh")`);
  check("the id is different", spineId !== ROSTER_ID, spineId);
  check("...and is a valid uuid the column will accept",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(spineId), spineId);
  check("...and is stable, so it isn't a new row every save",
    ev(`metaRowId("spine-singh")`) === spineId);
  check("...and two labs never collide",
    ev(`metaRowId("spine-singh")`) !== ev(`metaRowId("arthro-cole")`));

  console.log("\n-- Saving the roster writes this lab's row --");
  ev(`state.roster.push("Priya Raman"); pushRoster();`);
  await wait(250);
  const written = ev(`JSON.stringify((sb.__items.filter(r => r.kind === "meta")).map(r => ({ id: r.id, ws: r.workspace, n: r.data.names.length })))`);
  const rows = JSON.parse(written);
  check("still one meta row for this lab", rows.length === 1, rows);
  check("...the original id", rows[0].id === ROSTER_ID, rows[0]);
  check("...carrying the new name", rows[0].n === 3, rows[0]);

  console.log("\n-- A lab with no roster row starts empty, not with somebody else's --");
  // The regression this guards: `if (meta && ...)` leaves state.roster alone when there's no row,
  // so whatever was loaded last stays in the pickers. That's how a spine task gets assigned to a
  // sports coordinator.
  const spine = [profile("spine-singh"), meeting()];
  const w2 = boot(spine);
  await wait(600);
  check("the roster is empty", JSON.parse(w2.eval("JSON.stringify(state.roster)")).length === 0,
    w2.eval("JSON.stringify(state.roster)"));
  check("...and so are the degrees and aliases",
    w2.eval("Object.keys(state.rosterDegrees).length") === 0 && w2.eval("Object.keys(state.nameAliases).length") === 0);

  console.log("\n-- Another lab's roster row never reaches this lab --");
  // The database refuses it, but the app must not depend on that: a support grant genuinely does
  // hand over another lab's rows, and they must not land in the roster.
  const both = [profile("spine-singh"), metaRow(ROSTER_ID, "sports-yanke", ["Adam Yanke", "Carla Edwards"]), meeting()];
  const w3 = boot(both);
  await wait(600);
  const r3 = JSON.parse(w3.eval("JSON.stringify(state.roster)"));
  check("the sports names did not cross over", r3.length === 0, r3);
  check("...specifically not Adam's", !r3.includes("Adam Yanke"), r3);

  console.log("\n-- The deadline calendar is still shared, which was always right --");
  check("the sports-stamped meeting is visible to the spine lab",
    w3.eval("state.meetings.length") === 1, w3.eval("state.meetings.length"));

  console.log("\n-- The database rule matches --");
  if (!haveSql) {
    console.log("  skipped — supabase/migrations isn't in this checkout");
  } else {
  const sql = fs.readFileSync(require("path").join(SQL_DIR, "003-roster-per-lab.sql"), "utf8");
  check("meta is out of the read policy", !/kind in \('meeting','meta'\)/.test(sql), "003 still lists meta");
  check("...and meeting is still in it", /kind = 'meeting'/.test(sql));
  check("all four policies were replaced, not just read",
    ["workspace read", "workspace insert", "workspace update", "workspace delete"]
      .every(p => (sql.match(new RegExp('create policy "' + p + '"', "g")) || []).length === 1));
  // 001 is the file that put meta in the commons. If someone re-runs it after 003, the hole
  // reopens — so 003 has to be the later migration, by number.
  check("003 sorts after 001", "003-roster-per-lab.sql" > "001-workspaces.sql");
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
