// Change history — 28 Oct 2026 (migration 018).
//
// Adam: "can you keep an audit history of who changed what?"
//
// What these tests hold:
//   1. The server records it, not the app: an AFTER trigger on items, only changed fields, nothing
//      for a no-op save, append-only, readable by whoever can see the study / manage the lab.
//   2. A study page shows its history, loaded only when opened, newest first, with names.
//   3. Lab admins get the whole lab's under Settings; RAs don't get that section.
//   4. Structured values say "changed X" rather than dumping JSON; a server change is labelled.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const ME = "test-user-1", WILL = "user-will";
const SID = "11111111-1111-1111-1111-111111111111";
const now = new Date().toISOString();
const prof = (id, name, extra) => ({ id, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: Object.assign({ id, email: id + "@example.com", name, position: "Research assistant", reportsTo: "", alertEmail: "",
    alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 99, fieldsChosen: true, linkedTo: "", admin: false }, extra || {}) });
const audit = [
  { id: 1, at: "2026-10-28T14:00:00Z", actor: WILL, actor_email: "will@example.com", workspace: "sports-yanke", item_id: SID, kind: "study", study_id: SID, action: "update",
    changes: { phase: { from: "Enrolling", to: "Analysis" }, milestones: { from: [{ a: 1 }], to: [{ a: 2 }] } } },
  { id: 2, at: "2026-10-28T15:00:00Z", actor: null, actor_email: null, workspace: "sports-yanke", item_id: SID, kind: "study", study_id: SID, action: "update",
    changes: { enrollCurrent: { from: 10, to: 12 } } },
  { id: 3, at: "2026-10-28T13:00:00Z", actor: ME, actor_email: "me@example.com", workspace: "sports-yanke", item_id: "t1", kind: "task", study_id: SID, action: "insert",
    changes: { _created: { to: { title: "Draft methods" } } } },
];
function boot(meAdmin) {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items: [
        prof(ME, meAdmin ? "Adam Yanke" : "Casey Student", meAdmin ? { admin: true, position: "Clinician" } : {}),
        prof(WILL, "William Lee", { admin: true }),
        { id: SID, kind: "study", updated_at: now, workspace: "sports-yanke", data: { id: SID, title: "QMRI OCA", phase: "Analysis", pi: "Adam Yanke", team: ["Adam Yanke"] } },
      ], tables: { audit_log: JSON.parse(JSON.stringify(audit)) } }) };
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
  console.log("\n-- A study's history --");
  const w = boot(true); await wait(800);
  const d = w.document;
  w.eval(`tab = "studies"; detailStudyId = ${JSON.stringify(SID)}; studySectionState.history = false; render()`);
  await wait(50);
  const body = () => d.getElementById("study-history-body");
  check("the study page has a Change history section", !!d.querySelector('[data-sec-toggle="history"]'));
  check("...not loaded until opened", body() && !body().dataset.loaded);
  d.querySelector('[data-sec-toggle="history"]').click();
  await wait(100);
  const t = body().textContent.replace(/\s+/g, " ");
  check("opening it loads the study's changes", /Phase: Enrolling → Analysis/.test(t), t);
  check("...named by who made them", /William Lee/.test(t));
  check("...newest first", t.indexOf("Enrolled: 10 → 12") < t.indexOf("Phase: Enrolling"), t);
  check("a server-side change is labelled as such", /Email reader \/ admin/.test(t));
  check("structured fields say they changed rather than dumping JSON", /changed milestones/.test(t) && !/\{/.test(t), t);
  check("the study's tasks are in its history", /task “Draft methods”/.test(t) && /created/.test(t), t);

  console.log("\n-- The whole lab's, for lab admins --");
  w.eval(`tab = "settings"; detailStudyId = null; render()`);
  await wait(50);
  const btn = d.getElementById("lab-history-load");
  check("Settings has Change History for an admin", !!btn);
  check("...filed under Help, data & about", w.eval(`SETTINGS_CATEGORIES.find(c => c.keys.includes("Change History")).title`) === "Help, data & about");
  btn.click(); await wait(100);
  const lt = d.getElementById("lab-history-body").textContent.replace(/\s+/g, " ");
  check("it lists changes across the lab, with what each one was on", /QMRI OCA/.test(lt) && /William Lee/.test(lt), lt);

  console.log("\n-- RAs --");
  const w2 = boot(false); await wait(800);
  w2.eval(`tab = "settings"; render()`); await wait(50);
  check("no lab-wide history section for a non-admin", !w2.document.getElementById("lab-history-load"));

  console.log("\n-- Formatting --");
  check("blank values read as blank", w.eval(`auditValue("")`) === "blank" && w.eval(`auditValue(null)`) === "blank");
  check("lists of names are joined", w.eval(`auditValue(["A", "B"])`) === "A, B");
  check("an approval reads as one", w.eval(`auditLines({ action: "update", changes: { "reviewed:x": { from: null, to: { by: "a" } } } })[0]`) === "approved an item");
  check("an empty history says when recording began", /28 Oct 2026/.test(w.eval(`auditRowsHTML([], false)`)));

  console.log("\n-- The server side --");
  const sqlPath = PROJECT + "/supabase/migrations/018-audit-log.sql";
  if (!fs.existsSync(sqlPath)) console.log("  skip  supabase/ not in this checkout");
  else {
    const sql = fs.readFileSync(sqlPath, "utf8").replace(/--[^\n]*/g, "");
    check("an AFTER trigger on items, for insert, update and delete", /create trigger audit_items after insert or update or delete on public\.items/.test(sql));
    check("only changed fields are kept", /\(old\.data -> k\) is distinct from \(new\.data -> k\)/.test(sql));
    check("a save that changes nothing records nothing", /if ch = '\{\}'::jsonb then return null; end if;/.test(sql));
    check("who = the signed-in user", /auth\.uid\(\), nullif\(auth\.jwt\(\) ->> 'email', ''\)/.test(sql));
    check("append-only: nobody can write it from the app", /revoke insert, update, delete on public\.audit_log from authenticated, anon/.test(sql)
      && !/create policy "[^"]*" on public\.audit_log for (insert|update|delete)/.test(sql));
    check("readable by whoever can see the study, the lab's managers, or app admin",
      /public\.is_app_admin\(\)\s*or public\.sees_whole_lab\(workspace\)\s*or \(study_id is not null and exists \(select 1 from public\.items i where i\.id = audit_log\.study_id\)\)/.test(sql));
    check("a task's change is filed under its study", /r\.data ->> 'studyId'/.test(sql));
  }

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
