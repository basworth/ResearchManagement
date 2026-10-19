// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Three fixes: (1) invite links must land on a set-password screen rather than dropping the
// person straight into the app, (2) Society Subscriptions must list societies that only exist
// in the feed, (3) meetings with no announced deadline must stay visible on the board.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const future = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);

// ISHA/ORS are "feed-only" societies — absent from the original hardcoded SOCIETIES map.
const mockItems = [
  { id: "m1", kind: "meeting", data: { id: "m1", key: "ISHA|18th Annual", society: "ISHA", name: "18th ISHA Annual Scientific Meeting", type: "abstract", deadline: "", loiDeadline: "", studyIds: [], funded: [], hidden: false }, updated_at: now },
  { id: "m2", kind: "meeting", data: { id: "m2", key: "ORS|2027", society: "ORS", name: "ORS 2027 Annual Meeting", type: "abstract", deadline: future, loiDeadline: "", studyIds: [], funded: [], hidden: false }, updated_at: now },
  { id: "m3", kind: "meeting", data: { id: "m3", key: "AANA|2027", society: "AANA", name: "AANA 2027", type: "abstract", deadline: future, loiDeadline: "", studyIds: [], funded: [], hidden: false }, updated_at: now },
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} }, updated_at: now }
];

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

function build(url) {
  return new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url,
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items: mockItems }) };
    }
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---------- 1. Feed-only societies + undated meetings ----------
  const dom = build("http://localhost/");
  const window = dom.window, doc = window.document;
  await wait(350);
  window.eval('upsertProfile("Adam Yanke"); syncOnline = true;');
  await wait(60);

  console.log("\n-- Society list is derived from the data, not hardcoded --");
  const socs = JSON.parse(window.eval("JSON.stringify(Object.keys(allSocieties()))"));
  check("ISHA is a known society", socs.includes("ISHA"), socs);
  check("ORS is a known society", socs.includes("ORS"));
  check("The original hardcoded ones survive", ["AAOS", "AANA", "AOSSM", "OREF", "IPSG", "ICRS"].every(s => socs.includes(s)));
  check("Shoulder + international societies are named", ["ASES", "ICSES", "SECEC/ESSSE", "ESSKA", "ISAKOS"].every(s => socs.includes(s)), socs);
  check("The list is sorted", JSON.stringify(socs) === JSON.stringify(socs.slice().sort((a, b) => a.localeCompare(b))));
  check("ISHA gets a real full name, not just its code",
    window.eval('allSocieties()["ISHA"]') === "International Society for Hip Arthroscopy");

  // Since 19 Oct the societies are nested under the subspecialty they belong to, rather than a
  // flat A-to-Z list, so each one has to be expanded before its toggles render. The property this
  // was written to protect is unchanged and still what's checked: a society that exists only in
  // the feed — never in the hardcoded map — must still get a toggle, or it is visible on the
  // board and impossible to switch off.
  doc.querySelector('button[data-tab="settings"]').click();
  await wait(80);
  window.eval('allFields().forEach(f => settingsFieldOpen[f] = true); render();');
  await wait(120);
  const toggles = [...doc.querySelectorAll(".sub-toggle")].map(t => t.dataset.soc);
  check("Settings shows a toggle for ORS", toggles.includes("ORS"), toggles);
  check("Settings shows a toggle for ISHA", toggles.includes("ISHA"));
  check("Every society in the data has a toggle", socs.every(s => toggles.includes(s)),
    socs.filter(s => !toggles.includes(s)));
  // And it has to be under a sensible heading, not dumped in a catch-all.
  const orsField = window.eval('fieldOf({society:"ORS"})');
  check("ORS is filed under a subspecialty that makes sense", orsField === "Basic science", orsField);

  console.log("\n-- Turning a feed-only society off actually hides it --");
  window.eval('tab = "dashboard"; render();');
  await wait(80);
  check("ORS is on the board to begin with", doc.getElementById("main").innerHTML.includes("ORS 2027 Annual Meeting"));
  window.eval('setSub("ORS", false); render();');
  await wait(80);
  check("...and gone once unsubscribed", !doc.getElementById("main").innerHTML.includes("ORS 2027 Annual Meeting"));
  window.eval('setSub("ORS", true); render();');
  await wait(80);
  check("...and back when re-subscribed", doc.getElementById("main").innerHTML.includes("ORS 2027 Annual Meeting"));

  // Adam's call (2026-08-24): the board is for deadlines that can actually be acted on, so a
  // meeting with no published submission date is kept off it entirely — but it must still be
  // reachable and editable in Settings, and must come back once a date exists.
  console.log("\n-- A meeting with no announced date is kept OFF the board --");
  const board = doc.getElementById("main").innerHTML;
  check("The undated ISHA meeting is not on the board", !board.includes("18th ISHA Annual Scientific Meeting"));
  check("No TBA marker anywhere", !board.includes(">TBA<"));
  check("No 'not announced yet' wording", !board.includes("not announced yet"));
  check("Dated meetings are unaffected", board.includes("ORS 2027 Annual Meeting"));
  check("...and no bogus 'NaN days' leaked in", !/NaN/.test(board), (board.match(/.{0,40}NaN.{0,40}/) || [])[0]);
  check("...and no 'Invalid Date'", !/Invalid Date/.test(board));

  console.log("\n-- ...but it is still tracked, not lost --");
  doc.querySelector('button[data-tab="settings"]').click();
  await wait(80);
  // The meeting list collapsed on 19 Oct — it's a reference list, not something to scroll past on
  // every visit. Still reachable, which is the point being protected here.
  check("The collapsed header counts it without being opened",
    /undated/.test(doc.querySelector("[data-toggle-meetings]").textContent),
    doc.querySelector("[data-toggle-meetings]").textContent);
  window.eval('trackedMeetingsOpen = true; render();');
  await wait(120);
  const settings = doc.getElementById("main").innerHTML;
  check("It's listed under Tracked Meetings", settings.includes("18th ISHA Annual Scientific Meeting"), );
  check("It still exists in state", window.eval('state.meetings.some(m => m.society === "ISHA")') === true);

  console.log("\n-- Giving it a date brings it straight back --");
  window.eval(`(function(){ var m = state.meetings.find(x => x.society === "ISHA"); m.deadline = ${JSON.stringify(future)}; })(); tab = "dashboard"; render();`);
  await wait(80);
  const board2 = doc.getElementById("main").innerHTML;
  check("Once dated, it appears on the board", board2.includes("18th ISHA Annual Scientific Meeting"));
  check("...with a real day count", /\d+<\/div>\s*<div[^>]*>day/.test(board2));
  check("...and can be linked to a project", board2.includes('data-link-meeting="m1"'));
  window.eval('(function(){ var m = state.meetings.find(x => x.society === "ISHA"); m.deadline = ""; })(); render();');
  await wait(60);

  console.log("\n-- Editing a feed-only meeting keeps its society --");
  window.eval('openMeetingForm(state.meetings.find(m => m.society === "ISHA"))');
  await wait(80);
  const sel = doc.getElementById("f-msoc");
  check("The Society dropdown offers ISHA", !!sel && [...sel.options].some(o => o.value === "ISHA"));
  check("...and has it selected, so saving won't reassign it", sel && sel.value === "ISHA", sel && sel.value);
  doc.getElementById("sheet-cancel").click();
  await wait(50);

  // ---------- 2. Invite link handling ----------
  console.log("\n-- An invite link asks for a password instead of walking straight in --");
  const inv = build("http://localhost/#access_token=abc123&refresh_token=r1&type=invite");
  await wait(400);
  const idoc = inv.window.document;
  check("Login screen is showing", idoc.getElementById("login-screen").style.display !== "none");
  check("The set-password panel is visible", idoc.getElementById("login-recovery").style.display === "block");
  check("The email/password sign-in fields are hidden", idoc.getElementById("login-fields").style.display === "none");
  check("Copy is invite-flavoured, not 'reset your password'",
    /finish setting up your account/i.test(idoc.getElementById("recovery-intro").textContent),
    idoc.getElementById("recovery-intro").textContent);
  check("The app itself stays hidden until a password is chosen",
    inv.window.eval('document.getElementById("app").style.display') !== "block",
    inv.window.eval('document.getElementById("app").style.display'));
  check("It recognised the link as an invite", inv.window.eval("authLinkType") === "invite");
  check("...and flagged that a password is still needed", inv.window.eval("pendingPasswordSetup") === true);

  console.log("\n-- A recovery link reuses the same panel with its own wording --");
  const rec = build("http://localhost/#access_token=abc&type=recovery");
  await wait(400);
  check("Recovery also lands on the set-password panel",
    rec.window.document.getElementById("login-recovery").style.display === "block");
  check("...with reset wording, not invite wording",
    /Enter a new password/i.test(rec.window.document.getElementById("recovery-intro").textContent));

  console.log("\n-- A normal visit is unaffected --");
  const plain = build("http://localhost/");
  await wait(400);
  check("No stray set-password prompt on a normal load",
    plain.window.document.getElementById("login-recovery").style.display === "none");
  check("pendingPasswordSetup stays false", plain.window.eval("pendingPasswordSetup") === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
