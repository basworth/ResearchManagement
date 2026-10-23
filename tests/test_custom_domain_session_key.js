// Data goes through db.studypipeline.com, and the saved session keeps its old name. 22 Oct 2026.
//
// WHY THE DOMAIN: Rush's network blocks *.supabase.co. Before this change the page loaded from
// studypipeline.com but every row came from the supabase.co host, so on hospital wifi the app
// opened and then could not sign in ([[reference-rush-blocks-supabase-host]]). The Supabase
// custom-domain add-on serves the same project from db.studypipeline.com.
//
// WHY THE KEY: supabase-js names the session it saves in localStorage after the URL's first host
// label: "sb-wqgiqiqatdmoxpjbzxoj-auth-token" before this change, "sb-db-auth-token" after. Change
// the URL without pinning storageKey and everybody is silently signed out on their next visit. The
// boot check that looks for a saved session matches /^sb-.*-auth-token$/, so it would not catch
// this either.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}

const ROOT = path.join(__dirname, "..");
const app = fs.existsSync(path.join(ROOT, "research-tracker.html")) ? "research-tracker.html" : "index.html";
for (const f of [app, path.join("cases", "index.html")]) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { console.log("  skip", f, "(not present)"); continue; }
  const s = fs.readFileSync(p, "utf8");
  check(`${f}: data URL is db.studypipeline.com`, /const SUPABASE_DIRECT_URL = "https:\/\/db\.studypipeline\.com";/.test(s) && /let SUPABASE_URL = SUPABASE_DIRECT_URL;/.test(s));
  check(`${f}: the route is chosen before the client exists`, /await chooseSupabaseRoute\(\);\s*\n\s*sb = window\.supabase\.createClient/.test(s));
  check(`${f}: no hard-coded supabase.co host left`, !/https:\/\/[a-z0-9]+\.supabase\.co/.test(s));
  check(`${f}: session key pinned to the original name`, s.includes('storageKey: "sb-wqgiqiqatdmoxpjbzxoj-auth-token"'));
  const calls = s.match(/supabase\.createClient\([^)]*\)/g) || [];
  check(`${f}: every createClient passes the pinned options`, calls.length > 0 && calls.every(c => c.includes("SUPABASE_AUTH_OPTS")), calls);
}

console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
