// Where the app opens — 19 Oct 2026.
//
// Research is the first thing you see each day. But it's a briefing, and being dropped back on a
// briefing you've already read, every single time you refresh mid-task, is just an obstacle. So:
// same day, you land back where you were; new day (or new browser, or signed out), you land on
// Research.
//
// The sharp edges, each of which this file pins down:
//
//   1. The day is the user's LOCAL date, not elapsed hours. "Have I looked at this today" must not
//      depend on what time you closed the laptop.
//
//   2. A corrupt or hand-edited localStorage value must not brick the app at startup — `tab` is
//      assigned at module scope, so anything that throws there takes the whole page down before a
//      single pixel renders.
//
//   3. Only the tab is restored, never the sub-view. Reopening somebody's half-scrolled study
//      detail — or worse, a co-author's record, which is another person's data — would be
//      disorienting rather than helpful.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const USER = "u1";
const now = new Date().toISOString();
const profile = () => ({
  id: USER, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: { id: USER, email: "a@example.com", name: "Adam Yanke", position: "Clinician",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true,
    tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: true },
});
const study = () => ({
  id: "s1", kind: "study", updated_at: now, workspace: "sports-yanke",
  data: { id: "s1", title: "A study", phase: "Enrolling", design: "Retrospective",
    priority: "Medium", pi: "Adam Yanke" },
});

function today() {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

// `seed` is written into localStorage before the app's own script runs, which is the only way to
// exercise a module-scope decision.
function boot(seed) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      if (seed !== undefined) win.localStorage.setItem("rt-last-tab", seed);
      win.supabase = { createClient: () => makeMockSupabase({ items: [profile(), study()] }) };
    },
  });
  return dom.window;
}

const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}

(async () => {
  console.log("\n-- A first visit opens on Research --");
  let w = boot(undefined);
  await wait(500);
  check("nothing stored means Research", w.eval("tab") === "research", w.eval("tab"));

  console.log("\n-- ...and the visit is remembered as soon as anything renders --");
  const stored = JSON.parse(w.localStorage.getItem("rt-last-tab"));
  check("the key is written", !!stored, w.localStorage.getItem("rt-last-tab"));
  check("...with today's local date", stored && stored.day === today(), stored);
  check("...and the tab", stored && stored.tab === "research", stored);

  console.log("\n-- Same day, a refresh lands back where you were --");
  for (const t of ["studies", "tasks", "worklist", "notes", "settings", "dashboard"]) {
    const w2 = boot(JSON.stringify({ tab: t, day: today() }));
    await wait(350);
    check("  " + t + " is restored", w2.eval("tab") === t, w2.eval("tab"));
    w2.close();
  }

  console.log("\n-- A different day opens on Research again --");
  for (const day of ["2026-10-18", "2026-01-01", "2027-03-04"]) {
    const w3 = boot(JSON.stringify({ tab: "settings", day }));
    await wait(350);
    check("  " + day + " is not today, so Research", w3.eval("tab") === "research", w3.eval("tab"));
    w3.close();
  }

  console.log("\n-- The day is a local date, not an elapsed-hours guess --");
  // A value saved one second before local midnight is yesterday, even though it is minutes old.
  // Storing a timestamp and comparing hours would get this wrong.
  const y = new Date(Date.now() - 864e5), p = n => String(n).padStart(2, "0");
  const yesterday = y.getFullYear() + "-" + p(y.getMonth() + 1) + "-" + p(y.getDate());
  const w4 = boot(JSON.stringify({ tab: "tasks", day: yesterday }));
  await wait(350);
  check("yesterday's date opens on Research", w4.eval("tab") === "research", w4.eval("tab"));
  w4.close();

  console.log("\n-- Rubbish in localStorage must not brick startup --");
  // `tab` is assigned at module scope. Anything that throws here kills the page before it paints,
  // so each of these has to degrade to Research rather than propagate.
  const JUNK = [
    ["not JSON at all", "}{ broken"],
    ["empty string", ""],
    ["the literal null", "null"],
    ["a bare number", "42"],
    ["an array", "[1,2,3]"],
    ["an object with no fields", "{}"],
    ["a tab that doesn't exist", JSON.stringify({ tab: "nope", day: today() })],
    ["a tab that is an object", JSON.stringify({ tab: { x: 1 }, day: today() })],
    ["a missing day", JSON.stringify({ tab: "settings" })],
    ["a null day", JSON.stringify({ tab: "settings", day: null })],
    ["a prototype-polluting key", JSON.stringify({ tab: "__proto__", day: today() })],
  ];
  for (const [name, raw] of JUNK) {
    let wj, threw = null, got = null;
    try { wj = boot(raw); await wait(300); got = wj.eval("typeof tab === 'string' ? tab : null"); }
    catch (e) { threw = String(e); }
    check("  " + name + " falls back to Research", !threw && got === "research", threw || got);
    // The app must have actually booted, not just defined a variable.
    if (wj) {
      check("    ...and the app still rendered", !!wj.document.getElementById("main").innerHTML.trim());
      wj.close();
    }
  }

  console.log("\n-- Only the tab comes back, never the sub-view --");
  const w5 = boot(JSON.stringify({ tab: "studies", day: today() }));
  await wait(400);
  check("restored onto studies", w5.eval("tab") === "studies");
  check("...with no study open", w5.eval("detailStudyId") === null, w5.eval("detailStudyId"));
  check("...and no co-author open", w5.eval("coauthorName") === null, w5.eval("coauthorName"));
  check("...and not the old publications page", w5.eval("showPublications") === false);

  console.log("\n-- Switching tabs updates what gets restored --");
  w5.eval('tab = "worklist"; render();');
  await wait(60);
  const after = JSON.parse(w5.localStorage.getItem("rt-last-tab"));
  check("the new tab is stored", after.tab === "worklist", after);
  w5.close();

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
