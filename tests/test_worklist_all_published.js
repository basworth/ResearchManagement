// Worklist "All": publications at the bottom, newest first — 4 Nov 2026.
// Adam: "would be nice if that also included all published studies and sorted older publications
// at the bottom".
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const U = "test-user-1";
const st = (id, phase, pub) => ({ id, kind: "study", updated_at: now, workspace: "sports-yanke",
  data: Object.assign({ id, title: "T " + id, pi: "Adam Yanke", team: ["Adam Yanke"], phase, milestones: [] }, pub ? { publication: pub } : {}) });
const items = [
  { id: U, kind: "profile", updated_at: now, workspace: "sports-yanke", data: { id: U, name: "Adam Yanke", email: "a@b.c", position: "Clinician", admin: true,
    alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 999, fieldsChosen: true } },
  st("p2019", "Published", { year: "2019", pmid: "31000000" }),
  st("p2026a", "Published", { year: "2026", pmid: "40100000" }),
  st("act", "Analysis"),
  st("p2026b", "Published", { year: "2026", pmid: "40900000" }),
  st("hold", "On Hold"),
  st("p2022", "Published", { year: "2022", pmid: "35000000" }),
];
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true; win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items }) };
  } });
const w = dom.window;
let pass = 0, fail = 0;
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);
(async () => {
  await new Promise(r => setTimeout(r, 700));
  w.eval(`tab = "worklist"; worklistStatus = "all"; worklistPerson = "all"; worklistSort = { key: "", dir: 1 }; render()`);
  await new Promise(r => setTimeout(r, 100));
  const order = [...w.document.querySelectorAll("tr[data-open-study]")].map(r => r.dataset.openStudy);
  check("All includes every published study", ["p2019", "p2022", "p2026a", "p2026b"].every(id => order.includes(id)), order);
  check("active first, then On Hold, then publications newest to oldest",
    order.join(",") === "act,hold,p2026b,p2026a,p2022,p2019", order);
  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
