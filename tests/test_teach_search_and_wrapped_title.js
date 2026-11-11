// Searching for the study on an unmatched email, and titles wrapped over two lines — 11 Nov 2026.
// Adam: "please add a search option for the study name here". The email that prompted it
// (ARTH-26-418R2) printed the study's title across two lines with a curly apostrophe, so the
// exact-title rule missed a title that was there.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const U = "test-user-1", S = "aaaaaaaa-0000-0000-0000-0000000000f1", O = "aaaaaaaa-0000-0000-0000-0000000000f2";
const st = (id, title, nickname) => ({ id, kind: "study", updated_at: now, workspace: "sports-yanke", data: { id, title, nickname, pi: "Adam Yanke", team: [], phase: "Submitted", milestones: [], noteEntries: [] } });
const items = [
  { id: U, kind: "profile", updated_at: now, workspace: "sports-yanke", data: { id: U, name: "Adam Yanke", email: "a@b.c", position: "Clinician", admin: true, alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 999, fieldsChosen: true } },
  st(S, "Fluoroscopic Device Type and Condylar Alignment Alter the Projected Relationship Between Schöttle's Point and Medial Femoral Anatomy in a Cadaveric Study", "Fluoro Schottle"),
  st(O, "Something else entirely about hips", "Hip thing"),
  { id: "g1", kind: "suggestion", updated_at: now, workspace: "sports-yanke", data: { id: "g1", source: "email", status: "pending", subject: "FW: Your Submission", text: "nothing useful", changes: [], applied: [], studyId: "", forwardedBy: U, parserVersion: 99 } },
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
  console.log("\n-- A title wrapped over two lines, with a curly apostrophe --");
  const email = "Ref.:  Mss. No. ARTH-26-418R2\nFluoroscopic Device Type and Condylar Alignment Alter the Projected Relationship\n\nBetween Schöttle’s Point and Medial Femoral Anatomy in a Cadaveric Study\n\nDear Dr. Yanke";
  const r = JSON.parse(w.eval(`(function(){ var x = readEmail(${JSON.stringify(email)}, "Your Submission (ARTH-26-418R2)"); return JSON.stringify({ id: x.study ? x.study.id : "", basis: x.basis }); })()`));
  check("it's matched by its title", r.id === S && /study title/.test(r.basis), r);
  console.log("\n-- Searching for the study on an unmatched email --");
  w.eval(`tab = "settings"; render()`); await wait(80);
  const inp = d.querySelector('[data-sugg-teach="g1"]');
  check("the picker is a search box", inp && inp.tagName === "INPUT" && !!d.getElementById(inp.getAttribute("list")));
  check("...listing every study by title, with its nickname", d.getElementById(inp.getAttribute("list")).querySelectorAll("option").length === 2
    && /Fluoro Schottle/.test(d.getElementById(inp.getAttribute("list")).innerHTML));
  inp.value = "not a study"; inp.onchange(); await wait(20);
  check("typing something that isn't a study changes nothing", !w.eval(`(state.suggestions.find(g => g.id === "g1") || {}).studyId`));
  const inp2 = d.querySelector('[data-sugg-teach="g1"]');
  inp2.value = "Hip thing"; inp2.onchange(); await wait(50);
  check("picking by nickname files it under that study", w.eval(`state.suggestions.find(g => g.id === "g1").studyId`) === O);
  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
