// The app admin's org chart shows every lab's people — 27 Oct 2026 (migration 016).
//
// Adam: "the org chart on the website should show me all users for all labs". Grouped by lab, his
// own first and editable; other labs are shown but not edited from here. Anyone else sees only the
// chart they always did.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const ME = "test-user-1";
const now = new Date().toISOString();
const prof = (id, ws, name, extra) => ({ id, kind: "profile", updated_at: now, workspace: ws,
  data: Object.assign({ id, email: id + "@example.com", name, position: "Research Assistant", reportsTo: "", alertEmail: "",
    alertEmailAsked: true, degreesAsked: true, tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: false }, extra || {}) });
const items = () => [
  prof(ME, "sports-yanke", "Adam Yanke", { admin: true, position: "Clinician" }),
  prof("will", "sports-yanke", "William Lee", { admin: true, reportsTo: ME }),
  prof("cole", "sports-cole", "Brian Cole", { admin: true, position: "Clinician" }),
  prof("kao", "sports-cole", "Matthew Kao", { admin: true, reportsTo: "cole" }),
  prof("max", "spine-singh", "Maximillian Lee", { reportsTo: "singh-not-signed-in" }),
];
function boot() {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items: items() }) };
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
  const w = boot(); await wait(700);
  const ev = c => w.eval(c);
  ev(`appAdminIds = ["${ME}"]`);
  const chart = ev(`orgChartHTML(true)`);
  const div = w.document.createElement("div"); div.innerHTML = chart;
  const t = div.textContent.replace(/\s+/g, " ");
  console.log("\n-- The app admin sees every lab --");
  check("my lab first", /^\s*MY LAB · 2 PEOPLE/.test(t), t.slice(0, 80));
  check("then each other lab, named for its PI — never an RA", /COLE LAB · 2 PEOPLE/.test(t) && /SINGH LAB · 1 PERSON/.test(t), t);
  check("people sit under their own lab", t.indexOf("Matthew Kao") > t.indexOf("COLE LAB") && t.indexOf("William Lee") < t.indexOf("COLE LAB") && !/KAO'S LAB|FRIEDMAN'S LAB/.test(t));
  check("someone whose manager hasn't signed in still shows", /Maximillian Lee/.test(t));
  check("only my own lab is editable here", div.querySelectorAll('[data-org-edit="will"]').length === 1 && div.querySelectorAll('[data-org-edit="kao"]').length === 0);
  console.log("\n-- Anyone else: the chart as before --");
  ev(`appAdminIds = []`);
  const plain = ev(`orgChartHTML(true)`);
  check("no lab headings", !/MY LAB| LAB ·/.test(plain));
  const sql = path.join(PROJECT, "supabase", "migrations", "016-app-admin-sees-all-people.sql");
  if (fs.existsSync(sql)) {
    const body = fs.readFileSync(sql, "utf8").replace(/--[^\n]*/g, "");
    check("the database rule: profiles only, app admin only", /or \(kind = 'profile' and public\.is_app_admin\(\)\)/.test(body));
    check("every earlier read branch kept", ["can_see_meeting", "lab_pi_named(data)", "is_collaborator(data)", "has_support_access", "lm.workspace in"].every(x => body.includes(x)));
    check("write policies untouched", !/policy "workspace (insert|update|delete)"/.test(body));
  } else console.log("  skip  supabase/ not in this checkout");
  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
