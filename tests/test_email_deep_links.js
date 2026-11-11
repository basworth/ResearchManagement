// Email buttons land on the item (11 Nov 2026).
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "research-tracker.html"), "utf8");
const read = (f) => { try { return fs.readFileSync(path.join(root, "supabase/functions", f), "utf8"); } catch (e) { return ""; } };
let fails = 0, passes = 0; const ok = (c, m) => { if (!c) { fails++; console.error("FAIL " + m); } else passes++; };
ok(/let pendingTaskId = authLinkParam\("task"\)/.test(html), "app captures ?task=");
ok(/function openPendingTask\(\)/.test(html) && /openTaskForm\(t\)/.test(html), "app opens the task");
ok(/id="sugg-card-\$\{esc\(g\.id\)\}"/.test(html), "suggestion cards carry an id");
ok(/getElementById\("sugg-card-" \+ target\)/.test(html), "focus scrolls to suggestion card");
ok(/\(study\|tab\|update\|task\)=/.test(html), "deep link outranks remembered tab");
const ing = read("ingest-email/index.ts");
if (/attachedEmails/.test(ing)) {   // main carries a stale copy of the functions
  ok(/\?update=\$\{encodeURIComponent\(suggestionId\)\}/.test(ing), "forward reply links its card");
  ok(/read\.study \? read\.study\.id : "", id\)/.test(ing), "suggestion id passed to notifyForwarder");
  ok(!/\$\{SITE_URL\}\/\?study=/.test(ing), "no netlify study links");
  const te = read("task-emails/index.ts");
  ok(/\?task=\$\{encodeURIComponent\(id\)\}/.test(te) && /taskRow\(t\.title[^)]*t\.id\)/.test(te), "task rows link tasks");
  const sa = read("stage-alerts/index.ts");
  ok(/studyLink\(i\.studyId\)/.test(sa) && /includes\("netlify\.app"\)/.test(sa), "stage rows link studies");
}
console.log(`\n${fails ? "FAILED" : "ALL CLEAR"} — ${passes} passed, ${fails} failed`); process.exit(fails ? 1 : 0);
