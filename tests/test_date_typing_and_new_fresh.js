// 17 Nov 2026. Max Lee: typing a date "jumps to the next field after the first number".
// William Lee: new studies are automatically "smelly".
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const U = "test-user-1", S = "aaaaaaaa-0000-0000-0000-0000000000d1";
const items = [
  { id: U, kind: "profile", updated_at: now, workspace: "sports-yanke", data: { id: U, name: "Adam Yanke", email: "a@b.c", position: "Clinician", admin: true, alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 999, fieldsChosen: true } },
  { id: S, kind: "study", updated_at: now, workspace: "sports-yanke", data: { id: S, title: "Date study", pi: "Adam Yanke", team: [], phase: "Revisions Required", journal: "AJSM", decision: "Major revision", milestones: [], noteEntries: [] } },
];
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) { win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }); win.confirm = () => true; win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items }) }; } });
const w = dom.window, d = w.document;
let pass = 0, fail = 0;
const check = (n, c, x) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, x === undefined ? "" : "->" + JSON.stringify(x)), fail++);
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await wait(700); w.eval("syncOnline = true;");
  w.eval(`openStudy("${S}"); tab = "studies"; render()`); await wait(80);
  console.log("\n-- Typing a date --");
  let el = d.getElementById("ms-revisions-received");
  check("the Revisions received box is there", !!el);
  el.focus(); el.value = "0002-01-01"; el.dispatchEvent(new w.Event("change")); await wait(30);
  check("a part-typed date is not saved", !w.eval(`studyById("${S}").revisionsReceivedDate`));
  w.eval("render()"); await wait(30);
  check("a redraw doesn't throw the cursor out of the box", d.activeElement === el && d.body.contains(el));
  el.value = "2026-11-12"; el.dispatchEvent(new w.Event("change")); el.blur(); await wait(40);
  check("leaving the box saves the date", w.eval(`studyById("${S}").revisionsReceivedDate`) === "2026-11-12");
  check("...and the held redraw happens", !!d.getElementById("ms-revisions-received") && d.getElementById("ms-revisions-received") !== el);
  console.log("\n-- A brand-new study --");
  const f = JSON.parse(w.eval(`(function(){ var s = { id: "n1", title: "New one", pi: "Adam Yanke", team: [], phase: "Idea", createdAt: new Date().toISOString(), milestones: [], noteEntries: [] }; studyLastWork = {}; var r = freshness(s); return JSON.stringify(r); })()`));
  check("is not smelly, stale or rotten", !f || !/smelly|stale|rotten/i.test(JSON.stringify(f)), f);
  check("new studies record when they were added", /if \(!existing && !s\.createdAt\) s\.createdAt/.test(html));
  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
