// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Worklist gets the same Who/Phase/Design filters as Studies but with its OWN state, and
// filter sets can be saved by name and shared with everyone in the same org-chart team.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ADAM = "aaaaaaaa-0000-0000-0000-000000000001";   // root of the chart
const JORGE = "bbbbbbbb-0000-0000-0000-000000000002";  // surgeon under Adam -> team root
const STUD = "cccccccc-0000-0000-0000-000000000003";   // student under Jorge -> same team
const OTHER = "dddddddd-0000-0000-0000-000000000004";  // under Carla -> different team
const CARLA = "eeeeeeee-0000-0000-0000-000000000005";

const study = (id, title, pi, phase, design) => ({ id, kind: "study", data: { id, title, nickname: title, pi, team: [], design, phase, priority: "Medium", irb: id, milestones: [] }, updated_at: now });
const prof = (id, name, reportsTo, admin) => ({ id, kind: "profile", data: { id, email: name.toLowerCase().replace(/ /g, ".") + "@rushortho.com", name, position: "Research assistant", reportsTo, admin: !!admin }, updated_at: now });

const mockItems = [
  study("s1", "Adam Analysis Pro", "Adam Yanke", "Analysis", "Prospective (Consented)"),
  study("s2", "Adam Concept Retro", "Adam Yanke", "Concept", "Retrospective (Non-Consented)"),
  study("s3", "Jorge Analysis Retro", "Jorge Chahla", "Analysis", "Retrospective (Non-Consented)"),
  prof(ADAM, "Adam Yanke", "", true),
  prof(JORGE, "Jorge Chahla", ADAM, false),
  prof(STUD, "Student One", JORGE, false),
  prof(CARLA, "Carla Edwards", ADAM, false),
  prof(OTHER, "Other Person", CARLA, false),
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke", "Jorge Chahla", "Student One", "Carla Edwards", "Other Person"], degrees: {} }, updated_at: now }
];

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
let sharedItems = mockItems.map(r => JSON.parse(JSON.stringify(r)));
function build(asId, promptAnswer) {
  return new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.prompt = () => promptAnswer || "My View";
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => {
        const c = makeMockSupabase({ items: sharedItems });
        const u = sharedItems.find(r => r.id === asId);
        c.auth.getSession = async () => ({ data: { session: { user: { id: asId, email: u.data.email } } }, error: null });
        return c;
      } };
    }
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const d = build(ADAM); const w = d.window, doc = d.window.document;
  await wait(450);
  w.eval("syncOnline = true");

  console.log("\n-- Worklist now has the same filters as Studies --");
  w.eval('tab = "worklist"; render();');
  await wait(120);
  check("Who picker present", !!doc.getElementById("wl-person"));
  check("Phase picker present", !!doc.getElementById("wl-phase"));
  check("Design picker present", !!doc.getElementById("wl-design"));
  check("Search box still present", !!doc.getElementById("worklist-search"));
  check("Views bar present", !!doc.getElementById("fs-select-worklist"));

  console.log("\n-- Worklist filters actually filter --");
  w.eval('worklistPerson = "all"; render();');
  await wait(100);
  check("All projects shows three", (doc.getElementById("main").innerHTML.match(/data-open-study=/g) || []).length === 3,
    (doc.getElementById("main").innerHTML.match(/data-open-study=/g) || []).length);
  w.eval('worklistPhaseFilter = "Analysis"; render();');
  await wait(100);
  check("Phase filter narrows it", (doc.getElementById("main").innerHTML.match(/data-open-study=/g) || []).length === 2);
  w.eval('worklistDesignFilter = "Retrospective (Non-Consented)"; render();');
  await wait(100);
  check("Design filter narrows further", (doc.getElementById("main").innerHTML.match(/data-open-study=/g) || []).length === 1);
  check("...to the right one", doc.getElementById("main").innerHTML.includes("Jorge Analysis Retro"));

  console.log("\n-- The two tabs keep independent state --");
  w.eval('tab = "studies"; render();');
  await wait(120);
  check("Studies is untouched by the worklist filters", w.eval('studyPhaseFilter') === "All phases", w.eval('studyPhaseFilter'));
  check("Studies still on its own Who default", w.eval('personFilter') === "mine");
  check("Worklist kept its own selection", w.eval('worklistPhaseFilter') === "Analysis");

  console.log("\n-- A stale phase selection resets rather than showing nothing --");
  w.eval('worklistPerson = "mine"; worklistPhaseFilter = "Published"; tab = "worklist"; render();');
  await wait(120);
  check("Impossible phase falls back to All phases", w.eval('worklistPhaseFilter') === "All phases", w.eval('worklistPhaseFilter'));

  console.log("\n-- Saving a named view --");
  w.eval('tab = "studies"; personFilter = "all"; studyPhaseFilter = "Analysis"; render();');
  await wait(100);
  doc.getElementById("fs-save-studies").click();
  await wait(150);
  check("A filterSet record was created", w.eval("state.filterSets.length") === 1, w.eval("JSON.stringify(state.filterSets)"));
  const rec = JSON.parse(w.eval("JSON.stringify(state.filterSets[0])"));
  check("...named from the prompt", rec.name === "My View", rec.name);
  check("...scoped to the studies tab", rec.tab === "studies");
  check("...capturing the live filters", rec.filters.phase === "Analysis" && rec.filters.person === "all", rec.filters);
  check("...stamped with its owner", rec.ownerId === ADAM);
  check("...and synced as its own kind", w.eval('sb.__items.some(r => r.kind === "filterSet")') === true);

  console.log("\n-- Loading it restores the filters --");
  w.eval('personFilter = "mine"; studyPhaseFilter = "All phases"; render();');
  await wait(100);
  const sel = doc.getElementById("fs-select-studies");
  sel.value = rec.id;
  sel.dispatchEvent(new w.Event("change"));
  await wait(150);
  check("Who was restored", w.eval("personFilter") === "all", w.eval("personFilter"));
  check("Phase was restored", w.eval("studyPhaseFilter") === "Analysis");
  check("A Delete button appears once a view is active", !!doc.getElementById("fs-del-studies"));

  console.log("\n-- Team sharing follows the org chart --");
  const teamRoots = JSON.parse(w.eval(`JSON.stringify({
    adam: teamRootOf("${ADAM}"), jorge: teamRootOf("${JORGE}"),
    student: teamRootOf("${STUD}"), other: teamRootOf("${OTHER}")
  })`));
  check("Jorge is his own team root", teamRoots.jorge === JORGE, teamRoots);
  check("His student shares that root", teamRoots.student === JORGE);
  check("Someone under Carla is a different team", teamRoots.other === CARLA);

  // Jorge saves a view; his student should see it, Carla's report should not.
  const dj = build(JORGE, "Jorge Team View");
  await wait(450);
  dj.window.eval('syncOnline = true; tab = "studies"; render();');
  await wait(120);
  dj.window.document.getElementById("fs-save-studies").click();
  await wait(200);
  check("Jorge's view saved", dj.window.eval('state.filterSets.filter(f => f.name === "Jorge Team View").length') === 1);
  check("...stamped with his team root", dj.window.eval('state.filterSets.find(f => f.name === "Jorge Team View").teamRoot') === JORGE);

  const ds = build(STUD);
  await wait(450);
  ds.window.eval('syncOnline = true; tab = "studies"; render();');
  await wait(120);
  check("His student sees it", ds.window.eval('visibleFilterSets("studies").some(f => f.name === "Jorge Team View")') === true,
    ds.window.eval('JSON.stringify(visibleFilterSets("studies").map(f => f.name))'));

  const dOther = build(OTHER);
  await wait(450);
  dOther.window.eval('syncOnline = true; tab = "studies"; render();');
  await wait(120);
  check("Someone on another team does NOT see it",
    dOther.window.eval('visibleFilterSets("studies").some(f => f.name === "Jorge Team View")') === false,
    dOther.window.eval('JSON.stringify(visibleFilterSets("studies").map(f => f.name))'));

  const dAdam2 = build(ADAM);
  await wait(450);
  dAdam2.window.eval('syncOnline = true; tab = "studies"; render();');
  await wait(120);
  check("Adam, at the top of the chart, sees every team's views",
    dAdam2.window.eval('visibleFilterSets("studies").some(f => f.name === "Jorge Team View")') === true);

  console.log("\n-- Views are scoped to their tab --");
  check("A studies view isn't offered on the worklist",
    dAdam2.window.eval('visibleFilterSets("worklist").length') === 0,
    dAdam2.window.eval('JSON.stringify(visibleFilterSets("worklist").map(f => f.name))'));

  console.log("\n-- Re-saving the same name updates rather than duplicating --");
  const dj2 = build(JORGE, "Jorge Team View");
  await wait(450);
  // "Analysis" exists on every design track AND Jorge has a study in it — renderStudies clears a selection that matches
  // nothing, so picking "Concept" here would silently reset to "All phases" before saving.
  dj2.window.eval('syncOnline = true; tab = "studies"; studyPhaseFilter = "Analysis"; render();');
  await wait(120);
  dj2.window.document.getElementById("fs-save-studies").click();
  await wait(200);
  check("Still only one view with that name",
    dj2.window.eval('state.filterSets.filter(f => f.name === "Jorge Team View").length') === 1,
    dj2.window.eval('JSON.stringify(state.filterSets.map(f => f.name))'));
  check("...and it took the new filters",
    dj2.window.eval('state.filterSets.find(f => f.name === "Jorge Team View").filters.phase') === "Analysis",
    dj2.window.eval('state.filterSets.find(f => f.name === "Jorge Team View").filters.phase'));


  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
