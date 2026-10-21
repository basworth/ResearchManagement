// Blocker 3 of the multi-lab work, 15 Oct 2026.
//
// The edge functions hold the SERVICE ROLE KEY. That key bypasses row-level security completely,
// so the workspace policies that seal the labs apart in the browser do nothing at all in here.
// Every one of these functions reads `items` and then emails somebody. Before this was fixed,
// stage-alerts and task-emails read every study, task and profile in the database and mailed
// digests built from the lot.
//
// This test is structural on purpose. There is no safe way to run the real functions against the
// real database from a test, and a behavioural test against a mock would only prove the mock.
// What can be checked, and is worth checking, is that no unscoped bulk read of people's data
// creeps back in — because the failure is silent: nothing errors, the emails just quietly carry
// the wrong lab's work.
//
// The rule: a `.from("items").select(...)` that reads study, task, profile, matchHint or
// suggestion rows must ALSO carry either
//   * a workspace filter — `.eq("workspace", …)`, or `select("…, workspace")` with the grouping
//     done in code, or
//   * `.eq("id", …)` — a single named row, which is an authorisation question, not a listing.
// Anything else has to be listed in ALLOWED below with a reason someone can argue with.
const fs = require("fs");
const path = require("path");
const DIR = path.join(__dirname, "..", "supabase", "functions");

// The edge-function sources live in Adam's workspace folder and are deliberately NOT published to
// the public repo, so in CI there is nothing here to read. Say so and pass, rather than crashing.
//
// run-all.js has its own skip rule for this, but it works by grepping each test file for the
// literal string "supabase/" — and this file builds the path with path.join, so the rule never
// matched it. The result was a red CI run on every push, which is exactly the "train everyone to
// ignore a red run" failure that rule was written to prevent. A test that knows its own
// preconditions doesn't depend on another file guessing them correctly.
if (!fs.existsSync(DIR)) {
  console.log("SKIPPED — supabase/functions isn't in this checkout, so there are no sources to scan.");
  console.log("0 passed, 0 failed");
  process.exit(0);
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}

// Deliberate exceptions, each with the reason it is safe.
const ALLOWED = [
  {
    fn: "ingest-email",
    match: 'eq("kind", "profile")',
    why: "the sender must be identified before their lab is known; the very next statement " +
         "refuses anyone outside INGEST_WORKSPACE",
    requires: "INGEST_WORKSPACE",
  },
  {
    fn: "invite-user",
    match: 'eq("kind", "profile")',
    why: "names and labs for every account, used only to BUILD the wsById map that " +
         "visibleAccounts() then filters by",
    requires: "visibleAccounts",
  },
  {
    fn: "ingest-email",
    match: 'eq("kind", "meeting")',
    why: "the deadline catalogue is shared across every lab by design",
    requires: null,
  },
  {
    fn: "announce",
    match: 'eq("kind", "profile")',
    why: "an app admin's audience is legitimately every lab, so the read cannot be filtered in "
       + "SQL. It selects the workspace column and groups in code, and the audience a LAB admin "
       + "asks for is clamped to their own workspace on the server before this runs — the request "
       + "does not get to choose who a message reaches.",
    requires: "const audience = isAppAdmin",
  },
  {
    fn: "research-watch",
    match: 'eq("kind", "watchConfig")',
    why: "it is a scheduled job over every lab: it reads each lab's own feed settings in order "
       + "to run them. watchConfig holds search terms, not people's studies — and every read of "
       + "actual lab data inside the run IS scoped, which is asserted separately below.",
    requires: null,
  },
];

const SENSITIVE = ["study", "task", "profile", "matchHint", "suggestion"];

console.log("\n-- Every bulk read of people's data is scoped to one lab --");

// Named rather than counted, so adding a function is a deliberate edit here instead of a number
// going up. A scan that silently skips a new function is worse than no scan.
const EXPECTED = ["admin-requests", "announce", "feedback-alert", "import-publications",
                  "ingest-email", "invite-user", "request-update", "research-watch", "stage-alerts",
                  "task-emails"];
const fns = fs.readdirSync(DIR).filter((d) => fs.existsSync(path.join(DIR, d, "index.ts"))).sort();
check("every known function is scanned, and no unknown one is skipped",
  JSON.stringify(fns) === JSON.stringify(EXPECTED), { found: fns, expected: EXPECTED });

const unscoped = [];
for (const fn of fns) {
  const src = fs.readFileSync(path.join(DIR, fn, "index.ts"), "utf8");
  // Each `.from("items")` call and whatever is chained onto it. The chain ends at the statement's
  // semicolon OR at the next `.from(`, whichever comes first — two queries inside one Promise.all
  // share a statement, and a window that ran to the semicolon swallowed the second call's
  // `.eq("id", ROSTER_ID)` and reported the first one as scoped. Checked by replaying the real
  // unscoped version of stage-alerts, which the first draft of this test passed.
  const calls = (src.split('.from("items")').slice(1)).map((rest) => {
    const semi = rest.indexOf(";");
    const next = rest.indexOf(".from(");
    const end = Math.min(semi < 0 ? rest.length : semi, next < 0 ? rest.length : next);
    return rest.slice(0, end);
  });
  for (const call of calls) {
    if (!/\.select\(/.test(call)) continue;                 // writes are stamped, not filtered
    const kind = SENSITIVE.find((k) => call.includes(`"${k}"`));
    const bulkKinds = /\.in\("kind",/.test(call);
    if (!kind && !bulkKinds) continue;

    const scoped = /\.eq\("workspace"/.test(call)
      || /select\([^)]*workspace/.test(call)
      || /\.eq\("id"/.test(call);
    if (scoped) continue;

    const excuse = ALLOWED.find((a) => a.fn === fn && call.includes(a.match));
    if (excuse) {
      // An exception is only as good as the guard it points at.
      if (excuse.requires) {
        check(`${fn}: the "${excuse.why.slice(0, 40)}…" exception still has its guard`,
          src.includes(excuse.requires), excuse.requires);
      }
      continue;
    }
    unscoped.push({ fn, kind: kind || "several kinds", snippet: call.replace(/\s+/g, " ").slice(0, 120) });
  }
}
check("no unscoped bulk read of study, task, profile, matchHint or suggestion rows",
  unscoped.length === 0, unscoped);

console.log("\n-- The mailing functions group by lab rather than filtering after the fact --");
const stageAlerts = fs.readFileSync(path.join(DIR, "stage-alerts", "index.ts"), "utf8");
check("stage-alerts loops over workspaces", /for \(const ws of workspaces\)/.test(stageAlerts));
check("...and buckets recipients by lab, not by address alone",
  /ws \+ "\|" \+ email/.test(stageAlerts));

const taskEmails = fs.readFileSync(path.join(DIR, "task-emails", "index.ts"), "utf8");
check("task-emails loads profiles for one lab", /loadProfiles\(workspace: string\)/.test(taskEmails));
check("...and studies for one lab", /loadStudies\(workspace: string\)/.test(taskEmails));
check("...and the sweep loops over workspaces", /for \(const ws of workspaces\)/.test(taskEmails));
// Stronger than it was: the webhook's posted payload is ignored entirely and the task is re-read
// from the database, so the lab (and the task's own content) come from the stored row. The
// trigger that fires this sends the public anon key, so the payload can't be trusted at all.
check("...and the assignment webhook re-reads the stored task rather than trusting the payload",
  /stored\?\.data/.test(taskEmails) && /stored\.workspace/.test(taskEmails));
check("...and the sweep is scheduler-only", /fromScheduler\(req\)/.test(taskEmails));
const stageAlertsSrc = fs.readFileSync(path.join(DIR, "stage-alerts", "index.ts"), "utf8");
check("stage-alerts is scheduler-only too", /x-cron-secret/.test(stageAlertsSrc));
// Unset must mean open. A check that failed closed on a missing environment variable would stop
// every reminder the moment it deployed, before the secret was in place.
check("...and an unset secret leaves it open rather than silently stopping the mail",
  /if \(!CRON_SECRET\) return true;/.test(taskEmails)
  && /CRON_SECRET && req\.headers\.get\("x-cron-secret"\)/.test(stageAlertsSrc));

console.log("\n-- research-watch touches one lab at a time, even though it loops over all of them --");
{
  const fn = fs.readFileSync(path.join(DIR, "research-watch", "index.ts"), "utf8");
  // It runs under the service role, which bypasses RLS entirely. Every read of a lab's own data
  // therefore has to carry its own filter, and every write has to carry its stamp.
  check("it says out loud that the service role bypasses RLS",
    /SERVICE ROLE BYPASSES RLS/.test(fn));
  check("votes are read for one lab", /from\("items"\)[\s\S]{0,160}eq\("kind", "watchVote"\)[\s\S]{0,80}eq\("workspace", ws\)/.test(fn));
  check("the previous feed is read for one lab",
    /eq\("kind", "watchFeed"\)[\s\S]{0,120}eq\("workspace", cfg\.workspace\)/.test(fn));
  check("the feed it writes is stamped with that lab",
    /kind: "watchFeed"[\s\S]{0,200}workspace: cfg\.workspace/.test(fn));
  check("the config it writes back is stamped too",
    /kind: "watchConfig"[\s\S]{0,200}workspace: cfg\.workspace/.test(fn));
  check("a caller can narrow it to their own lab", /c\.workspace === only/.test(fn));
  check("a disabled lab is skipped", /c\.enabled !== false/.test(fn));
  check("one lab's failure doesn't stop the rest", /results\.push\(\{ workspace: cfg\.workspace, error/.test(fn));
  // The guard that makes a fabricated citation impossible rather than unlikely.
  check("only retrieved ids survive framing",
    /byPmid\.has\(String\(f\?\.pmid\)\)/.test(fn) && /byNct\.has\(String\(f\?\.id\)\)/.test(fn));
  check("the model is told never to introduce an id", /Never introduce another/.test(fn));
  check("a missing model key degrades rather than breaks", /if \(!ANTHROPIC_KEY\) return null/.test(fn));
  check("the feed records whether a model touched it", /framed: !!framed/.test(fn));
}

console.log("\n-- request-update refuses a study in another lab --");
const reqUpdate = fs.readFileSync(path.join(DIR, "request-update", "index.ts"), "utf8");
check("it compares the caller's lab to the study's", /callerWorkspace !== studyWorkspace/.test(reqUpdate));
// Returning 404 rather than 403 matters: a 403 would confirm the id names a real study in
// somebody's lab, which is the one fact the caller shouldn't be able to learn.
check("...and answers as though the study doesn't exist",
  /callerWorkspace !== studyWorkspace[\s\S]{0,300}no longer exists"\s*\}, 404\)/.test(reqUpdate));

console.log("\n-- Email ingest stays one lab's feature --");
const ingest = fs.readFileSync(path.join(DIR, "ingest-email", "index.ts"), "utf8");
check("there's a single ingest workspace", /INGEST_WORKSPACE/.test(ingest));
check("a sender from another lab is refused", /sender\.workspace !== INGEST_WORKSPACE/.test(ingest));
check("studies are searched within it only",
  /eq\("kind", "study"\)\.eq\("workspace", INGEST_WORKSPACE\)/.test(ingest));
// Without the stamp the row lands with a NULL workspace, which no policy matches — the forward is
// captured into a queue nobody can see.
check("the suggestion row is stamped", /kind: "suggestion"[\s\S]{0,120}workspace: INGEST_WORKSPACE/.test(ingest));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
