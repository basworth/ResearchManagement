// Who picker (17 Nov 2026): remembered across refreshes; lab admins who aren't the PI start on All.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const U = "test-user-1";
const st = (id, title, team) => ({ id, kind: "study", updated_at: now, workspace: "spine-singh", data: { id, title, pi: "Kern Singh", team, phase: "Data Collection", milestones: [], noteEntries: [] } });
const items = [
  { id: U, kind: "profile", updated_at: now, workspace: "spine-singh", data: { id: U, name: "Max Lee", email: "m@x.c", position: "Research assistant", admin: true, alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 999, fieldsChosen: true } },
  st("s1", "His study", ["Max Lee"]), st("s2", "Lab study one", ["Someone Else"]), st("s3", "Lab study two", []),
];
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) { win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }); win.confirm = () => true; win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items }) }; } });
const w = dom.window, d = w.document;
let pass = 0, fail = 0;
const check = (n, c, x) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, x === undefined ? "" : "->" + JSON.stringify(x)), fail++);
const wait = ms => new Promise(r => setTimeout(r, ms));
const cards = () => d.querySelectorAll("#main .card").length;
(async () => {
  await wait(700); w.eval("syncOnline = true;");
  w.eval(`myLabPiNames = ["kern singh"]; localStorage.removeItem(whoKey()); applyWhoDefaults(); tab = "studies"; detailStudyId = null; render()`); await wait(50);
  check("a lab admin who isn't the PI starts on All Projects", w.eval("personFilter") === "all" && w.eval("worklistPerson") === "all");
  check("...and sees the whole lab", /Lab study one/.test(d.getElementById("main").textContent) && /Lab study two/.test(d.getElementById("main").textContent));
  const sel = d.getElementById("person-filter"); sel.value = "mine"; sel.onchange({ target: sel }); await wait(30);
  w.eval(`personFilter = "all"; applyWhoDefaults(); render()`); await wait(30);
  check("a picked view survives a refresh", w.eval("personFilter") === "mine" && !/Lab study one/.test(d.getElementById("main").textContent));
  w.eval(`localStorage.removeItem(whoKey()); myLabPiNames = ["max lee"]; applyWhoDefaults()`);
  check("the lab's PI starts on My Projects", w.eval("personFilter") === "mine");
  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
