// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Past Deadlines: an abstract deadline that has lapsed AND has a project tagged to it moves
// into a collapsed archive showing each submission's status, with a team-wide Hide control.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const past = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
const older = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
const future = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);

const mockItems = [
  { id: "s1", kind: "study", data: { id: "s1", title: "Hip capsule repair", nickname: "HCR", pi: "Adam Yanke", team: [], design: "Prospective (Consented)", phase: "Concept", priority: "Medium", irb: "1", milestones: [], abstractDeadlineInfo: { mPast: { format: "Podium", status: "Accepted", acceptedFormat: "Podium" } } }, updated_at: now },
  { id: "s2", kind: "study", data: { id: "s2", title: "Meniscus root repair", nickname: "MRR", pi: "Adam Yanke", team: [], design: "Prospective (Consented)", phase: "Concept", priority: "Medium", irb: "2", milestones: [] }, updated_at: now },
  { id: "mPast", kind: "meeting", data: { id: "mPast", key: "AANA|Past", society: "AANA", name: "AANA 2026 Annual Meeting", type: "abstract", deadline: past, loiDeadline: "", studyIds: ["s1"], funded: [], hidden: false }, updated_at: now },
  { id: "mPast2", kind: "meeting", data: { id: "mPast2", key: "ISAKOS|Past", society: "ISAKOS", name: "ISAKOS 2026 Congress", type: "abstract", deadline: older, loiDeadline: "", studyIds: ["s2"], funded: [], hidden: false }, updated_at: now },
  { id: "mLapsedEmpty", kind: "meeting", data: { id: "mLapsedEmpty", key: "ORS|Lapsed", society: "ORS", name: "ORS Lapsed Untagged", type: "abstract", deadline: past, loiDeadline: "", studyIds: [], funded: [], hidden: false }, updated_at: now },
  { id: "mFuture", kind: "meeting", data: { id: "mFuture", key: "AOSSM|Future", society: "AOSSM", name: "AOSSM 2027 Annual Meeting", type: "abstract", deadline: future, loiDeadline: "", studyIds: ["s1"], funded: [], hidden: false }, updated_at: now },
  { id: "mGrant", kind: "meeting", data: { id: "mGrant", key: "OREF|PastGrant", society: "OREF", name: "OREF Lapsed Grant", type: "grant", deadline: past, loiDeadline: "", studyIds: ["s1"], funded: [], hidden: false }, updated_at: now },
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
  await wait(400);
  window.eval('upsertProfile("Adam Yanke"); syncOnline = true; tab = "dashboard"; render();');
  await wait(150);

  console.log("\n-- The section appears with the right things in it --");
  // Abstracts and grants were split into two archives on 2026-09-15, each with its own heading
  // and open/closed state, so the old single "Past Deadlines" heading no longer exists.
  check("A Past Abstract Deadlines heading exists", main().includes("Past Abstract Deadlines"));
  check("...counting only tagged ones", main().includes("(2 with submissions)"), (main().match(/\(\d+ with submissions\)/) || [])[0]);
  check("The lapsed-but-untagged deadline is excluded", !main().includes("ORS Lapsed Untagged"));
  check("A lapsed grant gets its own archive, not the abstract one",
    main().includes("Past Grant Deadlines") && main().includes("(1 with linked projects)"),
    (main().match(/\(\d+ with linked projects\)/) || [])[0]);
  check("The upcoming deadline stays on the live board", main().includes("AOSSM 2027 Annual Meeting"));
  check("...and is not duplicated into the past section",
    (main().match(/AOSSM 2027 Annual Meeting/g) || []).length === 1);

  console.log("\n-- It starts collapsed --");
  const body = doc.querySelector("[data-past-body]");
  check("The body is hidden initially", body && body.style.display === "none", body && body.style.display);
  // The old single `pastOpen` flag became per-kind state (abstract / grant) in the 2026-09-15
  // restructure. The DOM check on the line above is the meaningful assertion either way.
  doc.querySelector("[data-past-toggle]").click();
  await wait(80);
  check("Tapping the header opens it", doc.querySelector("[data-past-body]").style.display !== "none");

  console.log("\n-- Submissions and statuses are shown --");
  const open = doc.querySelector("[data-past-body]").innerHTML;
  check("The linked project is listed", open.includes("Hip capsule repair"));
  check("...with its real status", open.includes("Accepted"), null);
  check("A project with no recorded status shows the default", open.includes("Not Submitted"));
  check("The lapsed date is spelled out", /Was due/.test(open));
  check("Projects are clickable through to the study", open.includes('data-open-study="s1"'));

  console.log("\n-- Newest lapsed deadline sorts first --");
  const a = open.indexOf("AANA 2026"), b = open.indexOf("ISAKOS 2026");
  check("More recent one is above the older one", a > -1 && b > -1 && a < b, [a, b]);

  console.log("\n-- Hiding a finished meeting --");
  check("Each past row has a Hide control", open.includes('data-hide-meeting="mPast"'));
  doc.querySelector('[data-past-body] [data-hide-meeting="mPast"]').click();
  await wait(120);
  check("It sets the shared hidden flag", window.eval('state.meetings.find(m => m.id === "mPast").hidden') === true);
  check("...so it leaves the past section", !main().includes("AANA 2026 Annual Meeting"));
  check("...and the count drops", main().includes("(1 with submissions)"), (main().match(/\(\d+ with submissions\)/) || [])[0]);
  check("...while the other past entry stays", main().includes("ISAKOS 2026 Congress"));
  check("It's still recoverable from Settings", window.eval('state.meetings.some(m => m.id === "mPast")') === true);

  console.log("\n-- Unsubscribing a society also clears its past entries --");
  window.eval('setSub("ISAKOS", false); tab = "dashboard"; render();');
  await wait(120);
  check("The ISAKOS past entry is gone", !main().includes("ISAKOS 2026 Congress"));
  check("...and with nothing left, the section disappears", !main().includes("Past Deadlines"));
  window.eval('setSub("ISAKOS", true); render();');
  await wait(120);
  check("Re-subscribing brings it back", main().includes("ISAKOS 2026 Congress"));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
