// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// A save must carry only the fields the person actually changed. Before this, every save wrote
// the whole record as this tab held it, so any field the tab was behind on was silently reverted.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const SID = "study-1";
const now = new Date().toISOString();
const base = { id: SID, title: "Saddle OCA of the patella", nickname: "Saddle",
  design: "Prospective (Consented)", phase: "Analysis", priority: "Medium",
  irb: "22-0101", pi: "Adam Yanke", team: ["Divesh Sachdev"], noteEntries: [], abstracts: [] };
const mockItems = [{ id: SID, kind: "study", updated_at: now, data: JSON.parse(JSON.stringify(base)) }];

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
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);
const ev = code => window.eval(code);
const serverRow = () => mockItems.find(r => r.id === SID).data;
// Somebody else changes a field on the server that this tab never hears about.
function elsewhere(fields) {
  const row = mockItems.find(r => r.id === SID);
  row.data = Object.assign({}, row.data, fields);
  row.updated_at = new Date(Date.now() + 1000).toISOString();
}

(async () => {
  await wait(400);

  console.log("\n-- The field somebody else changed survives my save --");
  elsewhere({ irb: "22-0101-A", phase: "Manuscript" });
  ev(`const s = studyById(${JSON.stringify(SID)}); s.nickname = "Saddle paper";
      window.__d = pushItem("study", s);`);
  await window.__d; await wait(100);
  check("my own edit is saved", serverRow().nickname === "Saddle paper", serverRow().nickname);
  check("their IRB amendment survives", serverRow().irb === "22-0101-A", serverRow().irb);
  check("their phase change survives", serverRow().phase === "Manuscript", serverRow().phase);
  check("my local copy now shows theirs too",
    ev(`studyById(${JSON.stringify(SID)}).phase`) === "Manuscript", ev(`studyById(${JSON.stringify(SID)}).phase`));

  console.log("\n-- Same field, later save still wins that field --");
  elsewhere({ nickname: "Theirs" });
  ev(`const s = studyById(${JSON.stringify(SID)}); s.nickname = "Mine";
      window.__d2 = pushItem("study", s);`);
  await window.__d2; await wait(100);
  check("the later save takes the contested field", serverRow().nickname === "Mine", serverRow().nickname);

  console.log("\n-- Arrays and nested records --");
  elsewhere({ team: ["Divesh Sachdev", "William Lee"] });
  ev(`const s = studyById(${JSON.stringify(SID)});
      s.noteEntries = [{ id: "n1", text: "Data pull done", date: "2026-10-09", archivedOn: "" }];
      window.__d3 = pushItem("study", s);`);
  await window.__d3; await wait(100);
  check("my new note is saved", (serverRow().noteEntries || []).length === 1, serverRow().noteEntries);
  check("the teammate they added is still on the study",
    (serverRow().team || []).includes("William Lee"), serverRow().team);

  console.log("\n-- Deleting a field still works --");
  ev(`const s = studyById(${JSON.stringify(SID)}); delete s.nickname;
      window.__d4 = pushItem("study", s);`);
  await window.__d4; await wait(100);
  check("the field is gone on the server", serverRow().nickname === undefined, serverRow().nickname);

  console.log("\n-- Bulk pushes skip the merge --");
  elsewhere({ pi: "Someone Else" });
  ev(`const s = studyById(${JSON.stringify(SID)}); s.priority = "High";
      window.__d5 = pushItem("study", s, null, { merge: false });`);
  await window.__d5; await wait(100);
  check("the local copy is written wholesale", serverRow().pi !== "Someone Else", serverRow().pi);

  console.log("\n-- A brand new record is written as-is --");
  ev(`window.__d6 = pushItem("study", { id: "study-new", title: "New study", phase: "Concept",
      design: "Retrospective (Chart Review)", priority: "Low" });`);
  await window.__d6; await wait(100);
  check("it lands on the server", !!mockItems.find(r => r.id === "study-new"));

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
