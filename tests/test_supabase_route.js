// Falling back to the studypipeline.com proxy when every Supabase host is blocked — 23 Oct 2026.
//
// The morning after db.studypipeline.com went live, Adam's own machine loaded the site and failed
// every data call: that network blocked db.studypipeline.com AND the old supabase.co host (a
// filter that follows the CNAME). The page itself loaded, so studypipeline.com is allowed — and
// _redirects now proxies /sbp/* there to the project, server-side.
//
// Pinned here: the probe picks the proxy only when the direct host is unreachable, the client is
// built on whichever was picked, edge-function calls follow it, realtime is not attempted through a
// proxy that cannot carry websockets, and _redirects really does proxy (200), not redirect.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}
const now = new Date().toISOString();
const profile = { id: "test-user-1", kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: { id: "test-user-1", email: "a@rushortho.com", name: "Adam Yanke", position: "Clinician", reportsTo: "",
    alertEmail: "", alertEmailAsked: true, degreesAsked: true, tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: true } };

function boot(url, blocked) {
  const created = [];
  const fetched = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url,
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.fetch = async (u, init) => {
        fetched.push(String(u));
        if (blocked && /db\.studypipeline\.com|supabase\.co/.test(String(u))) throw new TypeError("Failed to fetch");
        return { ok: true, status: 200, json: async () => ({ ok: true, results: [] }) };
      };
      win.supabase = { createClient: (u) => { created.push(u); return makeMockSupabase({ items: [profile] }); } };
    },
  });
  return { w: dom.window, created, fetched };
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log("\n-- A network that lets Supabase through uses it directly --");
  let b = boot("https://studypipeline.com/", false);
  await wait(800);
  check("the client is built on db.studypipeline.com", b.created[0] === "https://db.studypipeline.com", b.created);
  check("route is direct", b.w.eval("SUPABASE_ROUTE") === "direct");

  console.log("\n-- A network that blocks every Supabase host goes through the site --");
  b = boot("https://studypipeline.com/", true);
  await wait(800);
  check("the client is built on studypipeline.com/sbp", b.created[0] === "https://studypipeline.com/sbp", b.created);
  check("route is proxy", b.w.eval("SUPABASE_ROUTE") === "proxy");
  check("edge-function calls follow the same route", b.w.eval("SUPABASE_URL + '/functions/v1/x'") === "https://studypipeline.com/sbp/functions/v1/x");
  b.w.eval("realtimeChannel = null; subscribeRealtime();");
  check("realtime is not attempted through the proxy", b.w.eval("realtimeChannel") === null);

  console.log("\n-- Anywhere else (tests, a local copy) nothing is probed --");
  b = boot("http://localhost/", true);
  await wait(800);
  check("localhost keeps the direct URL", b.created[0] === "https://db.studypipeline.com", b.created);
  check("...without probing", !b.fetched.some(u => /auth\/v1\/health/.test(u)));

  console.log("\n-- The proxy rule itself --");
  const red = fs.readFileSync(PROJECT + "/_redirects", "utf8").split("\n").filter(l => /^\/sbp\//.test(l.trim()));
  check("_redirects proxies /sbp/* to the project", red.length === 1 && /^\/sbp\/\*\s+https:\/\/wqgiqiqatdmoxpjbzxoj\.supabase\.co\/:splat\s+200\s*$/.test(red[0].trim()), red);

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
