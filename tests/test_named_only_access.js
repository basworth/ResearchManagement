// "Only the studies they're named on" — 29 Oct 2026 (migration 019).
//
// Adam, person by person: prior research team, a lab technician, a postdoc and the trainees
// (residents and fellows) see only studies they're named on; trainees report to no one and sit in
// their own group. Confirmed in chat before anything was applied. What these tests hold:
//   1. The org chart puts residents & fellows in their own group, not under Adam.
//   2. Everyone else keeps their place, with their category shown.
//   3. The server rule: flagged on the account (service role only), named rows only, writes held
//      to the same set, admins and lab members unchanged.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const ME = "test-user-1";
const now = new Date().toISOString();
const prof = (id, name, extra) => ({ id, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: Object.assign({ id, email: id + "@example.com", name, position: "Research assistant", reportsTo: "", alertEmail: "",
    alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 99, fieldsChosen: true, linkedTo: "", admin: false }, extra || {}) });
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}
(async () => {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items: [
        prof(ME, "Adam Yanke", { admin: true, position: "Clinician" }),
        prof("will", "William Lee", { admin: true, reportsTo: ME }),
        prof("div", "Divesh Sachdev", { reportsTo: ME, category: "prior-team" }),
        prof("anu", "Anu Hakimiyan", { reportsTo: ME, category: "lab-tech" }),
        prof("aus", "Austin Roberts", { position: "Orthopedic resident", category: "trainee" }),
        prof("nat", "Nathan Varady", { position: "Sports medicine fellow" }),
      ] }) };
    } });
  const w = dom.window;
  await new Promise(r => setTimeout(r, 800));
  const chart = w.eval(`orgChartForLab("sports-yanke", false)`);
  const div = w.document.createElement("div"); div.innerHTML = chart;
  const text = div.textContent.replace(/\s+/g, " ");
  const groupAt = text.indexOf("RESIDENTS & FELLOWS");
  check("residents & fellows have their own group", groupAt > 0, text);
  check("...with Austin (marked trainee) and Nathan (by role) in it", text.indexOf("Austin Roberts") > groupAt && text.indexOf("Nathan Varady") > groupAt);
  check("...and nobody else", text.indexOf("Divesh Sachdev") < groupAt && text.indexOf("William Lee") < groupAt);
  check("prior research team still reports to Adam, labelled", /Divesh Sachdev.*Prior research team/.test(text));
  check("the lab technician too", /Anu Hakimiyan.*Lab technician/.test(text));
  check("category is an org-chart field, so a stale save can't wipe it", w.eval(`ORG_CHART_FIELDS.includes("category")`));

  const sqlPath = PROJECT + "/supabase/migrations/019-named-only-access.sql";
  if (!fs.existsSync(sqlPath)) console.log("  skip  supabase/ not in this checkout");
  else {
    const sql = fs.readFileSync(sqlPath, "utf8").replace(/--[^\n]*/g, "");
    check("flagged on the account (app_metadata), which only the service role writes", /raw_app_meta_data->>'access' = 'named'/.test(sql) && !/raw_user_meta_data/.test(sql));
    check("everyone else's lab view is untouched", /workspace in \(select public\.my_workspaces\(\)\)\s*and not public\.named_only\(\)/.test(sql));
    check("named-only: their studies, tasks on them, files on them, own profile and prefs", /when 'study'\s+then public\.is_involved\(d\)/.test(sql)
      && /when 'task'\s+then public\.named_study_ok/.test(sql) && /when 'file'\s+then public\.file_on_my_study\(rid\)/.test(sql)
      && /when 'profile'\s+then rid = auth\.uid\(\)/.test(sql) && /else false/.test(sql));
    check("no team list for them", /kind = 'profile'\s*and not public\.named_only\(\)\s*and exists/.test(sql));
    check("updates and deletes are held to the same rows", (sql.match(/not public\.named_only\(\) or public\.named_row_ok\(kind, id, data\)/g) || []).length >= 3);
    check("studies naming them anywhere stay readable (012)", /kind = 'study' and \(public\.is_collaborator\(data\) or public\.assigned_on_study_strict/.test(sql));
  }
  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
