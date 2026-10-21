// The feed and the config must not share a row id — 21 Oct 2026.
//
// WHAT WENT WRONG, so it is not re-introduced: `items` is PRIMARY KEY (id). id alone, not
// (id, kind). The research-watch function wrote the feed under the config's id and then wrote the
// config under the same id, so the second write replaced the first and the row that survived was
// the config. The function reported `ok: true, papersOut: 8, trialsOut: 6` every single run and
// left no feed behind. Nothing errored, nothing logged, and the app fell back to the static
// watch-<lab>.json, which looked like a working feature for as long as the file was current.
//
// Two things are asserted here and both matter:
//   1. The ids differ. That is the bug.
//   2. The app's derivedRowId and the function's port of it agree character for character. If
//      they drift, the function writes to an id the app never looks at, which fails exactly as
//      silently as the bug it replaced.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}

const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.localStorage.setItem("rt-seeded", "1");
    win.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    win.supabase = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }) } }) };
  },
});
const w = dom.window;
const ev = (c) => w.eval(c);

(async () => {
  await new Promise(r => setTimeout(r, 400));

  console.log("\n-- The two rows are different rows --");
  const LABS = ["sports-yanke", "spine-singh", "sports-chahla", "sports-cole"];
  for (const ws of LABS) {
    const cfg = ev(`watchConfigRowId(${JSON.stringify(ws)})`);
    const feed = ev(`watchFeedRowId(${JSON.stringify(ws)})`);
    check(ws + ": config id and feed id differ", cfg && feed && cfg !== feed, { cfg, feed });
  }
  const allIds = LABS.flatMap(ws => [ev(`watchConfigRowId(${JSON.stringify(ws)})`), ev(`watchFeedRowId(${JSON.stringify(ws)})`)]);
  check("no two of the eight ids collide", new Set(allIds).size === 8, allIds);
  check("each is a well-formed uuid",
    allIds.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(id)), allIds);
  check("stable across calls",
    ev(`watchFeedRowId("sports-yanke")`) === ev(`watchFeedRowId("sports-yanke")`));

  console.log("\n-- The app reads the feed from the feed's id --");
  check("pullAll matches on watchFeedRowId, not watchConfigRowId",
    /kind === "watchFeed" && r\.id === watchFeedRowId\(ws\)/.test(html));
  check("...and its fallback stays inside this lab",
    /kind === "watchFeed" && r\.workspace === ws/.test(html));
  check("a realtime feed for another lab is ignored",
    /if \(!ws \|\| ws === myWorkspace\) \{ watchData = data;/.test(html));

  console.log("\n-- The function agrees with the app --");
  const FN = path.join(PROJECT, "supabase", "functions", "research-watch", "index.ts");
  if (!fs.existsSync(FN)) {
    console.log("  (skipped — supabase/functions isn't in this checkout)");
  } else {
    const fn = fs.readFileSync(FN, "utf8");
    check("the function no longer writes the feed under the config's id",
      !/const feedRowId = cfg\.id/.test(fn));
    check("it derives the feed id from the workspace",
      /watchFeedRowId\(cfg\.workspace\)/.test(fn));
    check("the primary-key hazard is written down where the next person will look",
      /PRIMARY KEY \(id\)/.test(fn));

    // Run the function's own derivedRowId and compare it to the app's for the same seeds. A
    // regex would pass on two implementations that disagree; only executing both can tell.
    const body = fn.slice(fn.indexOf("function derivedRowId"));
    const end = body.indexOf("\n}\n");
    const src = body.slice(0, end + 2).replace(/: string/g, "").replace(/: number/g, "");
    const fnDerive = new Function(src + "; return derivedRowId;")();
    for (const ws of LABS) {
      check(ws + ": function and app derive the same feed id",
        fnDerive("watchFeed:" + ws) === ev(`watchFeedRowId(${JSON.stringify(ws)})`),
        { fn: fnDerive("watchFeed:" + ws), app: ev(`watchFeedRowId(${JSON.stringify(ws)})`) });
    }
    check("...and the same config id for a seed the app also builds",
      fnDerive("watchConfig:sports-yanke") === ev(`watchConfigRowId("sports-yanke")`));

    console.log("\n-- A write that fails is not reported as a run that worked --");
    check("the feed write's error is read", /feedWrite\.error/.test(fn));
    check("the config write's error is read", /cfgWrite\.error/.test(fn));
    check("and it throws rather than returning counts",
      /throw new Error\("feed built but not stored/.test(fn));
    check("the result says where the feed went", /feedRowId, stored: true/.test(fn));
  }

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
