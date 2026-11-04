// Freshness from real work, smelly, and dated next steps — 4 Nov 2026.
//
// Adam: "why is almost nothing stale or rotten on my projects?" — every save (tagging, bulk fixes)
// reset the clock. Then: meeting updates count; "a category called smelly that is more than 7 days
// past any changes"; and "be aware of any dates mentioned in next steps … it should only pop up
// there once it has been past that date by a certain number of days".
//
// What these tests hold:
//   1. With study_last_work() available, a bulk save (row updated_at today) doesn't make a study fresh.
//   2. A person's real edit, or a meeting email that applied a change, does.
//   3. 7 days = smelly, 14 = stale, 28 = rotten.
//   4. Before history began, the latest dated note or file is used; failing that, 28 Oct.
//   5. An open task or milestone dated in the future holds it fresh; once that date passes, the
//      count starts from the date.
//   6. If study_last_work() isn't there, it falls back to the old row-timestamp rule.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const DAY = 86400000;
const ago = (n) => new Date(Date.now() - n * DAY).toISOString();
const dayAgo = (n) => ago(n).slice(0, 10);
const now = new Date().toISOString();
const study = (id, extra) => ({ id, kind: "study", updated_at: now, workspace: "sports-yanke",
  data: Object.assign({ id, title: "Study " + id, pi: "Adam Yanke", team: ["Adam Yanke"], phase: "Analysis", milestones: [] }, extra || {}) });
const prof = { id: "test-user-1", kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: { id: "test-user-1", email: "a@example.com", name: "Adam Yanke", position: "Clinician", admin: true, alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 999, fieldsChosen: true } };
const items = [prof,
  study("bulk"), study("edited"), study("meeting"),
  study("smelly8"), study("stale15"), study("rotten30"),
  study("noteOld", { noteEntries: [{ id: "n", text: "old", date: "2026-09-01" }] }),
  study("nothing"),
  study("waiting", {}), study("pastDue", { milestones: [{ name: "Draft due", date: dayAgo(9), done: false }] }),
  { id: "tw", kind: "task", updated_at: now, workspace: "sports-yanke", data: { id: "tw", studyId: "waiting", title: "Send draft", assignees: [], done: false, due: dayAgo(-10) } },
  { id: "mtg", kind: "suggestion", updated_at: now, workspace: "sports-yanke", data: { id: "mtg", source: "meeting", status: "applied", createdAt: ago(2),
    applied: [{ id: "c1", studyId: "meeting", label: "Enrolled", to: "12" }], notApplied: [] } },
];
const lastWork = [
  { study_id: "edited", at: ago(1) }, { study_id: "meeting", at: ago(40) }, { study_id: "smelly8", at: ago(8) },
  { study_id: "stale15", at: ago(15) }, { study_id: "rotten30", at: ago(30) }, { study_id: "waiting", at: ago(40) }, { study_id: "pastDue", at: ago(40) },
  { study_id: "bulk", at: ago(20) },
];
function boot(rpcs) {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items, rpcs }) };
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
  const w = boot({ study_last_work: lastWork }); await wait(800);
  const f = (id) => JSON.parse(w.eval(`JSON.stringify(freshness(studyById(${JSON.stringify(id)})))`));
  console.log("\n-- Real work, not any save --");
  check("the history was loaded", w.eval("!!studyLastWork"));
  check("a bulk-saved row (updated_at today) is still stale by real work", f("bulk").level === "stale", f("bulk"));
  check("a person's edit yesterday is fresh", f("edited").level === "fresh");
  check("a meeting email that updated it 2 days ago counts as work", f("meeting").level === "fresh", f("meeting"));
  console.log("\n-- Smelly, stale, rotten --");
  check("8 days is smelly", f("smelly8").level === "smelly", f("smelly8"));
  check("15 days is stale", f("stale15").level === "stale");
  check("30 days is rotten", f("rotten30").level === "rotten");
  console.log("\n-- Before history began --");
  check("a study with only an old dated note goes by the note", f("noteOld").level === "rotten" && f("noteOld").days > 60, f("noteOld"));
  const sinceStart = Math.floor((Date.now() - new Date("2026-10-28T12:00:00Z").getTime()) / DAY);
  check("a study with nothing at all counts from 28 Oct", f("nothing").days === sinceStart, [f("nothing"), sinceStart]);
  console.log("\n-- Dated next steps --");
  check("an open task due in 10 days holds a 40-day-quiet study fresh", f("waiting").level === "fresh" && f("waiting").waitingUntil === dayAgo(-10), f("waiting"));
  check("a milestone 9 days overdue counts from its date: smelly, not rotten", f("pastDue").level === "smelly" && f("pastDue").days === 8 && f("pastDue").nextDue === dayAgo(9), f("pastDue"));
  w.eval(`tab = "worklist"; worklistStatus = "all"; worklistPerson = "all"; render()`); await wait(100);
  const row = (id) => w.document.querySelector(`tr[data-open-study="${id}"]`);
  check("a smelly row is tagged SMELLY", row("smelly8") && /SMELLY · 8d/.test(row("smelly8").innerHTML) && row("smelly8").className === "wl-smelly");
  check("a waiting row says when its next step is", row("waiting") && /next step/.test(row("waiting").innerHTML));
  console.log("\n-- Without the history function --");
  const w2 = boot({}); await wait(800);
  check("falls back to the row timestamp", w2.eval("studyLastWork === null") && JSON.parse(w2.eval(`JSON.stringify(freshness(studyById("bulk")))`)).level === "fresh");
  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
