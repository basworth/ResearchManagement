// Studies list = dashboard (15 Nov 2026). Max Lee: "After refresh, the studies homepage only shows
// one study. The dashboard in the top left still displays the other active studies." The list's
// "mine" filter matched names exactly; the dashboard (visibleStudies) also matches by surname and
// the people you manage. And a study you added yourself, without your name on it, vanished.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const U = "test-user-1";
const st = (id, title, pi, team) => ({ id, kind: "study", updated_at: now, workspace: "sports-yanke", data: { id, title, pi, team, phase: "Data Collection", milestones: [], noteEntries: [] } });
const items = [
  { id: U, kind: "profile", updated_at: now, workspace: "sports-yanke", data: { id: U, name: "Max Lee", email: "m@x.c", position: "Research assistant", admin: false, alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 999, fieldsChosen: true } },
  st("s1", "Exact name study", "Adam Yanke", ["Max Lee"]),
  st("s2", "Surname study", "Adam Yanke", ["Maxwell Lee"]),
  st("s3", "Another surname study", "Adam Yanke", ["M. Lee"]),
  st("s4", "Not his", "Adam Yanke", ["Someone Else"]),
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
  const dash = w.eval(`visibleStudies().filter(isActive).length`);
  w.eval(`tab = "studies"; detailStudyId = null; render()`); await wait(60);
  const titles = [...d.querySelectorAll("#main .card")].map(c => c.textContent).join("|");
  check("dashboard counts three", dash === 3, dash);
  check("the Studies list shows the same three", /Exact name study/.test(titles) && /Surname study/.test(titles) && /Another surname study/.test(titles) && !/Not his/.test(titles), titles.slice(0, 300));
  w.eval(`upsertStudy({ id: "s5", title: "Study I added for someone else", pi: "Adam Yanke", team: ["Someone Else"], phase: "Idea", createdBy: "${U}", milestones: [], noteEntries: [] }); render()`); await wait(60);
  check("a study he added himself stays visible", /Study I added for someone else/.test(d.getElementById("main").textContent));
  check("new studies are stamped with who added them", /s\.createdBy = currentUser\.id/.test(html));
  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
