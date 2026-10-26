// A study naming a lab's PI can be read AND edited by whoever manages that lab — 26 Oct 2026 (014).
//
// Adam: "these are my studies so they dont need to be named on them, but cole should so visa vi
// they would be able to see them in his lab". Matthew Kao and Lee Friedman are in sports-cole
// only; Adam's joint studies name Brian Cole. They must see those without their own names on
// them, and Brian himself must see QMRI OCA, where he is only in a combined PI field.
//
// What these tests hold:
//   1. The client mirror agrees with the SQL split (Team, or anywhere in a combined PI field).
//   2. Full names only — a surname, or a longer name containing it, does not count.
//   3. Edit, not take: update/insert open only for a study that already exists in that same lab;
//      delete is untouched. Managers only (lab admin / section coverage), never app admin.
//   4. Every lab is opted in the same way, Adam's included.
//   5. pullAll keeps those rows, except while viewing a lab under support access.
//   6. If the rpc is missing, the client keeps fewer rows, never more.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const ME = "test-user-1";
const now = new Date().toISOString();
const profile = () => ({
  id: ME, kind: "profile", updated_at: now, workspace: "sports-cole",
  data: { id: ME, email: "m@example.com", name: "Matthew Kao", position: "Research Coordinator",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true,
    tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: false },
});
const study = (id, ws, data) => ({ id, kind: "study", updated_at: now, workspace: ws, data: Object.assign({ id, title: id, phase: "Enrolling" }, data) });

function boot(rpcs) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items: [
        profile(),
        study("qmri-oca", "sports-yanke", { pi: "Adam Yanke, Brian Cole, Jorge Chahla", team: ["Adam Yanke"] }),
        study("rom", "sports-yanke", { pi: "Adam Yanke", team: ["Adam Yanke", "Brian Cole"] }),
        study("adam-only", "sports-yanke", { pi: "Adam Yanke", team: ["Adam Yanke", "William Lee"] }),
      ], rpcs: rpcs || {} }) };
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
  const w = boot({ my_lab_pi_names: ["brian cole"] });
  await wait(700);
  const ev = (c) => w.eval(c);
  const named = (d) => ev(`labPiNamedOn(${JSON.stringify(d)})`);

  console.log("\n-- The lab's PI named on a study --");
  check("on the Team", named({ team: ["Adam Yanke", "Brian Cole"] }) === true);
  check("sole PI", named({ pi: "Brian Cole" }) === true);
  check("inside a combined PI field", named({ pi: "Adam Yanke, Brian Cole, Jorge Chahla" }) === true);
  check("joined with 'and'", named({ pi: "Adam Yanke and Brian Cole" }) === true);
  check("joined with ; / &", named({ pi: "Adam Yanke; Brian Cole" }) && named({ pi: "Adam Yanke / Brian Cole" }) && named({ pi: "Adam Yanke & Brian Cole" }));
  check("case and whitespace don't matter", named({ team: ["  BRIAN COLE "] }) === true);

  console.log("\n-- Full names only --");
  check("surname alone", named({ team: ["Cole"] }) === false);
  check("a longer name containing it", named({ pi: "Brian Coleman" }) === false);
  check("a name that merely contains 'and'", named({ pi: "Brandon Cole" }) === false);
  check("not named at all", named({ pi: "Adam Yanke", team: ["William Lee"] }) === false);
  check("a blank study", named({}) === false);

  console.log("\n-- What reaches the screen --");
  const ids = ev(`JSON.stringify(state.studies.map(s => s.id).sort())`);
  check("the two joint studies arrive and are kept", /qmri-oca/.test(ids) && /rom/.test(ids), ids);
  check("Adam's study without Cole is not kept", !/adam-only/.test(ids), ids);
  check("pullAll applies it only outside a support view", /!viewWorkspace && r\.kind === "study" && labPiNamedOn\(r\.data\)/.test(html));

  console.log("\n-- Fails closed --");
  const w2 = boot({});   // my_lab_pi_names missing → error → empty list
  await wait(700);
  check("no rpc means no extra rows", !/qmri-oca|"rom"/.test(w2.eval(`JSON.stringify(state.studies.map(s => s.id))`)));
  check("...and the list is empty, not a wildcard", w2.eval(`myLabPiNames.length`) === 0);

  console.log("\n-- The server rule --");
  const sqlPath = PROJECT + "/supabase/migrations/014-lab-pi-visibility.sql";
  if (!fs.existsSync(sqlPath)) {
    console.log("  skip  supabase/ not in this checkout");
  } else {
    const sql = fs.readFileSync(sqlPath, "utf8");
    const body = sql.replace(/--[^\n]*/g, "");
    check("read, update and insert change; delete does not",
      /create policy "workspace read"/.test(body) && /create policy "workspace update"/.test(body)
      && /create policy "workspace insert"/.test(body) && !/policy "workspace delete"/.test(body));
    check("the read branch is study-only", /or \(\s*kind = 'study'\s*and public\.lab_pi_named\(data\)\s*\)/.test(body));
    const ins = (body.match(/create policy "workspace insert"[\s\S]*?\);/) || [""])[0];
    const upd = (body.match(/create policy "workspace update"[\s\S]*?\);/) || [""])[0];
    check("insert opens only for a study already in that lab", /kind = 'study' and public\.lab_pi_named\(data\) and public\.study_stays_put\(id, workspace\)/.test(ins), ins);
    check("update's new row must stay in its lab", /with check[\s\S]*lab_pi_named\(data\) and public\.study_stays_put\(id, workspace\)/.test(upd), upd);
    check("study_stays_put checks the same id, kind and lab", /i\.id = row_id and i\.kind = 'study' and i\.workspace = ws/.test(body));
    const mgr = (body.match(/function public\.manages_lab[\s\S]*?\$\$;/) || [""])[0];
    check("managing = lab admin of my lab or section coverage", /is_lab_admin\(\) and ws = public\.my_workspace\(\)/.test(mgr) && /my_division_workspaces/.test(mgr));
    check("...never app admin", !/is_app_admin/.test(mgr));
    check("the PI list is managers-only", /lab_pis where public\.manages_lab\(workspace\)/.test(body));
    const g = (body.match(/function public\.guard_relabel[\s\S]*?\$\$;/) || [""])[0];
    check("nobody outside a study's lab can move it", /new\.workspace is distinct from old\.workspace/.test(g)
      && /old\.workspace in \(select public\.my_workspaces\(\)\)/.test(g) && /errcode = '42501'/.test(g)
      && /create trigger guard_relabel before update on public\.items/.test(body), g);
    check("...service-role moves still work", /auth\.uid\(\) is not null/.test(g));
    check("every lab's PI is stated", ["'sports-yanke',  'Adam Yanke'", "'sports-cole',   'Brian Cole'", "'sports-chahla', 'Jorge Chahla'", "'spine-singh',   'Kern Singh'"].every(x => body.includes(x)));
    check("the earlier branches are all still there",
      /is_collaborator\(data\)/.test(body) && /assigned_on_study_strict/.test(body) && /has_support_access/.test(body) && /kind = 'profile'/.test(body));
    check("the PI split matches the client's separators", /\(\?:,\|;\|\/\|&\|\\mand\\M\)/.test(body));
  }

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
