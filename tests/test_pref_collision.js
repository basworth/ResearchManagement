// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Society-subscription changes silently reverted because a person's `userPref` row and their
// `profile` row were both keyed by the auth user id — same primary key in `items`, so each
// upsert clobbered the other and profiles (written on every sign-in) always won.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const future = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
const mockItems = [
  { id: "m2", kind: "meeting", data: { id: "m2", key: "ORS|2027", society: "ORS", name: "ORS 2027 Annual Meeting", type: "abstract", deadline: future, loiDeadline: "", studyIds: [], funded: [], hidden: false }, updated_at: now },
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
const rows = () => JSON.parse(window.eval("JSON.stringify(sb.__items.map(r => ({id: r.id, kind: r.kind})))"));

(async () => {
  await wait(350);
  window.eval('upsertProfile("Adam Yanke"); syncOnline = true;');
  await wait(80);
  const uid = window.eval("currentUser && currentUser.id");
  check("Signed in with an auth user id", !!uid, uid);

  console.log("\n-- The derived preferences row id --");
  const pid = window.eval(`prefRowId(${JSON.stringify(uid)})`);
  check("prefRowId is a valid uuid shape", /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(pid), pid);
  check("...and is NOT the auth user id", pid !== uid, { pid, uid });
  check("...and is stable across calls", window.eval(`prefRowId(${JSON.stringify(uid)})`) === pid);
  check("...and differs for a different user",
    window.eval('prefRowId("11111111-1111-1111-1111-111111111111")') !== pid);

  console.log("\n-- Saving a subscription no longer destroys the profile row --");
  const profileBefore = rows().filter(r => r.kind === "profile").length;
  check("A profile row exists to begin with", profileBefore === 1, rows());
  window.eval('setSub("ORS", false)');
  await wait(120);
  const after = rows();
  check("A userPref row now exists", after.some(r => r.kind === "userPref"), after);
  check("...stored under the derived id", after.some(r => r.kind === "userPref" && r.id === pid), after);
  check("...and the profile row survived", after.filter(r => r.kind === "profile").length === 1, after);
  check("...so profile and userPref are two separate rows",
    after.filter(r => r.kind === "profile")[0].id !== after.filter(r => r.kind === "userPref")[0].id);
  check("No two rows share an id", new Set(after.map(r => r.id)).size === after.length, after);

  console.log("\n-- The choice actually persists and takes effect --");
  check("The saved pref is recorded against the user id",
    window.eval('JSON.stringify((state.userPrefs.find(p => p.id === currentUser.id) || {}).subs)') === '{"ORS":false}',
    window.eval('JSON.stringify(state.userPrefs)'));
  check("subs() reports ORS as off", window.eval('subs()["ORS"]') === false);
  window.eval('tab = "dashboard"; render();');
  await wait(80);
  check("ORS is off the board", !doc.getElementById("main").innerHTML.includes("ORS 2027 Annual Meeting"));

  console.log("\n-- Signing in again must not wipe it (the original bug) --");
  window.eval('upsertProfile("Adam Yanke")');
  await wait(120);
  check("The userPref row is still there after a profile write",
    rows().some(r => r.kind === "userPref" && r.id === pid), rows());
  check("...and ORS is still switched off", window.eval('subs()["ORS"]') === false);

  console.log("\n-- Full re-push of local state doesn't collide --");
  const pushErr = await window.eval(`(async () => {
    try { await pushAllLocal(); return "ok"; } catch (e) { return String(e && e.message || e); }
  })()`);
  check("pushAllLocal completes without a duplicate-id error", pushErr === "ok", pushErr);
  check("...and still leaves exactly one row per id",
    new Set(rows().map(r => r.id)).size === rows().length, rows());

  console.log("\n-- A realtime update replaces the pref rather than duplicating it --");
  const before = window.eval("state.userPrefs.length");
  window.eval(`applyRealtimeRow("userPref", ${JSON.stringify(pid)}, { id: currentUser.id, name: "Adam Yanke", subs: { ORS: true } }, new Date().toISOString())`);
  await wait(60);
  check("Still only one preferences entry", window.eval("state.userPrefs.length") === before,
    window.eval("JSON.stringify(state.userPrefs)"));
  check("...and it took the incoming value", window.eval('subs()["ORS"]') === true);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
