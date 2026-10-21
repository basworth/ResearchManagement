// Every edge function must allow the headers supabase-js actually sends — 21 Oct 2026.
//
// WHAT BROKE: the functions allowed `authorization, content-type` and nothing else. supabase-js
// sends `apikey` and `x-client-info` on every `sb.functions.invoke()` (and newer builds add
// `x-supabase-api-version`), so the browser's preflight asked for headers the function would not
// allow, the preflight was rejected, and the POST was never sent.
//
// The failure mode is what made it expensive. The browser reports only "Failed to fetch" and
// supabase-js turns that into "Failed to send a request to the Edge Function" — no status code,
// nothing in the function's logs, because the request never arrived. It reads exactly like the
// network block in [[reference-rush-blocks-supabase-host]], which is the wrong thing to go and
// debug. Meanwhile REST keeps working, so the app looks half alive: studies load, but inviting,
// approving an admin request, asking for an update, importing publications and "Refresh now" all
// die silently.
//
// The app pulls supabase-js from a CDN, so the set of headers it sends can change without anyone
// deploying anything. That is why the allow-list has to be generous rather than exact: CORS is
// not the security boundary here — every function checks the caller's JWT itself.
const fs = require("fs");
const path = require("path");
const DIR = path.join(__dirname, "..", "supabase", "functions");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}

// supabase-js v2 sends these. Omitting any one of them kills every browser call to that function.
const REQUIRED = ["authorization", "content-type", "apikey", "x-client-info", "x-supabase-api-version"];

if (!fs.existsSync(DIR)) {
  console.log("  (skipped — supabase/functions isn't in this checkout)");
  console.log("\nALL CLEAR — 0 passed, 0 failed");
  process.exit(0);
}

const fns = fs.readdirSync(DIR).filter((d) => fs.existsSync(path.join(DIR, d, "index.ts"))).sort();
check("there are functions to check", fns.length > 0, fns);

for (const fn of fns) {
  const src = fs.readFileSync(path.join(DIR, fn, "index.ts"), "utf8");
  const m = src.match(/"Access-Control-Allow-Headers": "([^"]*)"/);
  if (!m) { check(fn + ": declares Access-Control-Allow-Headers", false); continue; }
  const allowed = m[1].split(",").map((h) => h.trim().toLowerCase());
  const missing = REQUIRED.filter((h) => !allowed.includes(h));
  check(fn + ": allows every header supabase-js sends", missing.length === 0, { missing, allowed });
  check(fn + ": answers the preflight", /OPTIONS/.test(src), fn);
}

// The two that carry a shared secret must keep allowing it, or the scheduler and the mail hop
// start failing in the same invisible way.
const ingest = path.join(DIR, "ingest-email", "index.ts");
if (fs.existsSync(ingest)) {
  check("ingest-email still allows x-ingest-secret",
    /"Access-Control-Allow-Headers": "[^"]*x-ingest-secret/.test(fs.readFileSync(ingest, "utf8")));
}
for (const n of ["stage-alerts", "task-emails"]) {
  const p = path.join(DIR, n, "index.ts");
  if (fs.existsSync(p)) {
    check(n + " still allows x-cron-secret",
      /"Access-Control-Allow-Headers": "[^"]*x-cron-secret/.test(fs.readFileSync(p, "utf8")));
  }
}

console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
