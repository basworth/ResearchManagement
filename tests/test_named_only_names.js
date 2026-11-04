// Named-only people see what the server sends them — 4 Nov 2026.
//
// Matt Kingery: "Received email that I was added to studies, but unable to access them here. Not
// sure if it has to do with differences in listed name on the study versus name associated with
// email (Matt Kingery versus Matthew Kingery)." The server (019) sent him the three studies; the
// app's exact-name check then hid them all.
//
// What these tests hold:
//   1. A named-only person sees every study the server sends, whatever spelling the study uses.
//   2. Anyone else is matched by surname too, like the server, so "Matt X" finds "Matthew T. X".
//   3. A merged alias works from either side.
//   4. Someone not on a study, by any spelling, still doesn't see it.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const ME = "test-user-1";
const now = new Date().toISOString();
const prof = (name, extra) => ({ id: ME, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: Object.assign({ id: ME, email: "m@example.com", name, position: "Fellow", category: "trainee", reportsTo: "", alertEmail: "",
    alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 999, fieldsChosen: true, linkedTo: "", admin: false }, extra || {}) });
const study = (id, title, team) => ({ id, kind: "study", updated_at: now, workspace: "sports-yanke",
  data: { id, title, phase: "Concept", pi: "Adam Yanke", team } });
function boot(name, appMetadata, studies, meta) {
  const items = [prof(name)].concat(studies);
  if (meta) items.push({ id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now, workspace: "sports-yanke", data: meta });
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items, appMetadata }) };
    } });
  return dom.window;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}
const titles = (w) => JSON.parse(w.eval("JSON.stringify(visibleStudies().map(s => s.title).sort())"));

(async () => {
  console.log("\n-- Named-only: whatever the server sent --");
  const w = boot("Matthew T. Kingery", { access: "named" }, [
    study("11111111-1111-1111-1111-111111111111", "Study 1", ["Adam Yanke", "Matt Kingery"]),
    study("22222222-2222-2222-2222-222222222222", "Study 2", ["Adam Yanke", "Matt Kingery"]),
  ]);
  await wait(800);
  check("the app knows he's named-only", w.eval("namedOnly()") === true);
  check("both studies the server sent are shown", JSON.stringify(titles(w)) === '["Study 1","Study 2"]', titles(w));
  check("...and each opens", w.eval(`canSeeStudy(studyById("11111111-1111-1111-1111-111111111111"))`) === true);

  console.log("\n-- Everyone else: surname, as the server does --");
  const w2 = boot("Matthew T. Kingery", {}, [
    study("11111111-1111-1111-1111-111111111111", "On it as Matt", ["Adam Yanke", "Matt Kingery"]),
    study("33333333-3333-3333-3333-333333333333", "Not on it", ["Adam Yanke", "William Lee"]),
  ]);
  await wait(800);
  check("not named-only", w2.eval("namedOnly()") === false);
  check("'Matt Kingery' on a study finds 'Matthew T. Kingery'", JSON.stringify(titles(w2)) === '["On it as Matt"]', titles(w2));
  check("a study he isn't on stays hidden", w2.eval(`canSeeStudy(studyById("33333333-3333-3333-3333-333333333333"))`) === false);

  console.log("\n-- A merged alias works from the study's side --");
  const w3 = boot("Matthew T. Kingery", {}, [
    study("11111111-1111-1111-1111-111111111111", "Alias", ["Adam Yanke", "Matt K"]),
  ], { nameAliases: { "matt k": "Matthew T. Kingery" } });
  await wait(800);
  check("an alias on the study resolves to his profile name",
    w3.eval(`studyInvolvesPerson(studyById("11111111-1111-1111-1111-111111111111"), "Matthew T. Kingery")`) === true);

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
