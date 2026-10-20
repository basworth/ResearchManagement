// The research feed belongs to one lab — 20 Oct 2026.
//
// watch.json was a single global file every lab fetched. Kern Singh signed into a brand-new spine
// lab and was shown osteochondral allograft and meniscus papers under the heading "New papers that
// touch YOUR publications". Not a crash: confidently wrong, about somebody else's field, as the
// first thing he saw, because Research is the landing tab. Worse than an empty page.
//
// Three things have to hold, and each failed at some point while building this:
//
//   1. The filename carries the lab, with NO fallback to the global file for anyone else. A
//      fallback is how the bug existed in the first place.
//
//   2. The fetch happens after the lab is known. At startup myWorkspace is still the default —
//      the real one arrives with the first pull — so a single fetch at boot gives every lab
//      sports-yanke's file and keeps it.
//
//   3. A lab with no file shows NO watch section, and still shows its own publication figures.
//      Empty is honest; borrowed is not.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const USER = "test-user-1";
const now = new Date().toISOString();
const profile = (ws) => ({
  id: USER, kind: "profile", updated_at: now, workspace: ws,
  data: { id: USER, email: "a@example.com", name: "Adam Yanke", position: "Clinician",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true,
    tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: true },
});

// Records every URL the app asks for, so the test can assert WHICH file was requested rather than
// inferring it from what rendered.
function boot(ws, files) {
  const asked = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.fetch = async (url) => {
        const path = String(url).split("?")[0];
        asked.push(path);
        if (Object.prototype.hasOwnProperty.call(files, path)) {
          return { ok: true, json: async () => files[path] };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      };
      win.supabase = { createClient: () => makeMockSupabase({ items: [profile(ws)] }) };
    },
  });
  return { win: dom.window, asked };
}

const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}

const SPORTS = { schema: 1, generated: "2026-10-19",
  inDevelopment: [{ id: "NCT1", kind: "Phase II", meta: "m", title: "Cartilage trial",
    frame: "f", forWork: "w", short: "cartilage" }], newPapers: [] };
const SPINE = { schema: 1, generated: "2026-10-20", workspace: "spine-singh",
  inDevelopment: [{ id: "NCT9", kind: "Cohort", meta: "m", title: "Cervical fusion study",
    frame: "f", forWork: "w", short: "spine" }], newPapers: [] };

(async () => {
  console.log("\n-- The filename carries the lab --");
  {
    const { win } = boot("sports-yanke", {});
    await wait(500);
    check("sports-yanke still reads watch.json",
      win.eval('watchFileFor("sports-yanke")') === "./watch.json");
    check("a new lab gets its own name",
      win.eval('watchFileFor("spine-singh")') === "./watch-spine-singh.json");
    check("...and so does another", win.eval('watchFileFor("sports-cole")') === "./watch-sports-cole.json");
    check("an unknown lab never silently becomes the default",
      win.eval('watchFileFor("spine-singh")') !== "./watch.json");
    win.close();
  }

  console.log("\n-- A spine lab is never served the sports file --");
  {
    // Both files exist. The spine lab must ask for its own and must not fall back.
    const { win, asked } = boot("spine-singh",
      { "./watch.json": SPORTS, "./watch-spine-singh.json": SPINE });
    await wait(1200);
    check("it asked for the spine file", asked.some(u => u === "./watch-spine-singh.json"), asked);
    const data = JSON.parse(win.eval("JSON.stringify(watchData)"));
    check("it loaded the spine content", !!data && /Cervical/.test(JSON.stringify(data)), data && data.generated);
    check("...and none of the cartilage content", !/Cartilage trial/.test(JSON.stringify(data)));
    win.close();
  }

  console.log("\n-- A lab with no file gets nothing, not somebody else's --");
  {
    const { win, asked } = boot("spine-singh", { "./watch.json": SPORTS });
    await wait(1200);
    check("it asked for its own file", asked.some(u => u === "./watch-spine-singh.json"), asked);
    check("watchData stays null", win.eval("watchData") === null, win.eval("JSON.stringify(watchData)"));
    // The tab must still render — the publication figures are unrelated to the watch feed.
    win.eval('tab = "research"; render();');
    const out = win.document.getElementById("main").innerHTML;
    check("the tab still renders", out.length > 200, out.length);
    check("...and says the watch half is empty", /No Research Watch data for your lab yet/.test(out));
    check("...and shows no cartilage anywhere", !/Cartilage trial/.test(out));
    win.close();
  }

  console.log("\n-- The fetch waits for the real lab, it doesn't keep the boot-time guess --");
  {
    const { win } = boot("spine-singh", { "./watch.json": SPORTS, "./watch-spine-singh.json": SPINE });
    await wait(1200);
    check("the loaded file is tagged with this lab",
      win.eval("watchDataFor") === "spine-singh", win.eval("watchDataFor"));
    // Asking again is a no-op; asking after a lab change refetches.
    win.eval('fetchResearchWatch();');
    check("a repeat call doesn't clear it", win.eval("watchData !== null"));
    win.close();
  }
  check("the pull refetches once the lab is known",
    /loadSupportGrants\(\);[\s\S]{0,320}fetchResearchWatch\(\)/.test(html));
  check("a repeat for the same lab short-circuits", /watchDataFor === ws\) return/.test(html));
  check("switching lab drops the old content first",
    /watchDataFor = ws;\s*\n\s*watchData = null;/.test(html));

  console.log("\n-- A file that names the wrong lab is refused --");
  {
    const { win } = boot("sports-cole", { "./watch-sports-cole.json": SPINE });  // SPINE claims spine-singh
    await wait(1200);
    check("mislabelled content is ignored", win.eval("watchData") === null,
      win.eval("JSON.stringify(watchData)"));
    win.close();
  }

  console.log("\n-- Malformed files are still survivable --");
  for (const [label, body] of [["null", null], ["a string", "nope"], ["an array", [1,2,3]], ["a number", 7]]) {
    const { win } = boot("spine-singh", { "./watch-spine-singh.json": body });
    await wait(900);
    let threw = null;
    try { win.eval('tab = "research"; render();'); } catch (e) { threw = String(e); }
    check("  " + label + " doesn't break the tab", !threw, threw);
    win.close();
  }

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
