// Lab membership becomes a set — 19 Oct 2026, migration 008.
//
// Until now a person belonged to exactly one lab: my_workspace() returned a string and every
// policy compared it with `=`. That cannot express "Carla covers all of Sports", and with labs
// going one-per-PI, cross-lab staff are the normal case rather than the exception.
//
// The dangerous part is not the reading, it is the WRITING. Before this, pushItem stamped every
// save with the editor's own lab. The moment anybody belongs to two, opening a study in Chahla's
// lab and saving it would stamp it with Carla's primary lab and silently move the study out of
// his — no error, no warning, the study simply gone from where its owner looks for it. That is
// the first thing tested here.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const SQL_DIR = path.join(PROJECT, "supabase", "migrations");
const haveSql = fs.existsSync(SQL_DIR);

const CARLA = "carla-id";
const now = new Date().toISOString();
const profile = (id, name, ws, admin) => ({
  id, kind: "profile", updated_at: now, workspace: ws,
  data: { id, email: name.toLowerCase().replace(/\W/g, "") + "@example.com", name,
    position: "Research manager (CRCM)", reportsTo: "", alertEmail: "", alertEmailAsked: true,
    degreesAsked: true, tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: !!admin },
});
const study = (id, title, ws) => ({
  id, kind: "study", updated_at: now, workspace: ws,
  data: { id, title, design: "Prospective (Consented)", phase: "Analysis", priority: "Medium" },
});

function boot(items, members) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({
        items, userId: CARLA, tables: { lab_members: members || [] } }) };
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
  // Carla's own lab is sports-yanke; she also covers sports-chahla.
  const items = [
    profile(CARLA, "Carla Edwards", "sports-yanke", true),
    study("y1", "Cartilage restoration outcomes", "sports-yanke"),
    study("c1", "ACL graft choice", "sports-chahla"),
    study("s1", "Cage subsidence", "spine-singh"),
  ];
  const members = [
    { user_id: CARLA, workspace: "sports-yanke", source: "profile" },
    { user_id: CARLA, workspace: "sports-chahla", source: "granted" },
  ];
  const w = boot(items, members);
  await wait(700);
  const ev = (c) => w.eval(c);

  console.log("\n-- She sees both her labs, and nobody else's --");
  check("membership loaded", JSON.parse(ev("JSON.stringify(labsIAmIn().sort())")).join(",") === "sports-chahla,sports-yanke",
    ev("JSON.stringify(labsIAmIn())"));
  const titles = JSON.parse(ev("JSON.stringify(state.studies.map(s => s.title).sort())"));
  check("her own lab's study is there", titles.includes("Cartilage restoration outcomes"), titles);
  check("...and the lab she covers", titles.includes("ACL graft choice"), titles);
  check("...but not the spine lab she has nothing to do with", !titles.includes("Cage subsidence"), titles);

  console.log("\n-- Editing a study in the OTHER lab does not move it --");
  // The bug this migration could have introduced. Her primary lab is sports-yanke; the study
  // belongs to sports-chahla and must stay there.
  check("stampFor keeps the study in its own lab",
    ev('stampFor("study", "c1")') === "sports-chahla", ev('stampFor("study", "c1")'));
  ev('(function(){ const s = state.studies.find(x => x.title === "ACL graft choice"); s.priority = "High"; upsertStudy(s); })()');
  await wait(300);
  const moved = JSON.parse(ev('JSON.stringify(sb.__items.filter(r => r.id === "c1").map(r => ({ ws: r.workspace, pri: r.data.priority })))'));
  check("the saved row still belongs to sports-chahla", moved[0] && moved[0].ws === "sports-chahla", moved);
  check("...and the edit actually saved", moved[0] && moved[0].pri === "High", moved);

  console.log("\n-- Her own lab's studies still stamp as hers --");
  check("a study in her primary lab keeps it", ev('stampFor("study", "y1")') === "sports-yanke");

  console.log("\n-- A brand-new record goes to her primary lab --");
  // Nothing in remoteMeta for an id the server has never seen, so it falls through to the lab
  // in view — which, when not under a support grant, is her own.
  check("an unknown id stamps as her primary lab",
    ev('stampFor("study", "brand-new-id")') === "sports-yanke", ev('stampFor("study", "brand-new-id")'));

  console.log("\n-- Her own profile never follows the view --");
  check("her profile stamps as her own lab",
    ev(`stampFor("profile", ${JSON.stringify(CARLA)})`) === "sports-yanke");

  console.log("\n-- Someone in one lab is unaffected --");
  const solo = boot([profile("solo-id", "Jay Amin", "sports-yanke"), study("y2", "Only mine", "sports-yanke"),
                     study("c2", "Not mine", "sports-chahla")], []);
  await wait(700);
  // No lab_members rows at all — the profile fallback has to carry them, or everyone is locked out
  // the moment the table is empty or unreachable.
  check("an empty membership table still yields their own lab",
    JSON.parse(solo.eval("JSON.stringify(labsIAmIn())")).join(",") === "sports-yanke",
    solo.eval("JSON.stringify(labsIAmIn())"));
  const soloTitles = JSON.parse(solo.eval("JSON.stringify(state.studies.map(s => s.title))"));
  check("they see their own lab", soloTitles.includes("Only mine"), soloTitles);
  check("...and not the other one", !soloTitles.includes("Not mine"), soloTitles);

  console.log("\n-- Under a support grant, the labs don't merge --");
  // Viewing another lab must show THAT lab alone. Merging it with her own two would put three
  // labs' studies in one list with no way to tell them apart.
  ev('viewWorkspace = "spine-singh"; window.__p = pullAll();');
  await w.__p;
  await wait(200);
  const underGrant = JSON.parse(ev("JSON.stringify(state.studies.map(s => s.title))"));
  check("only the supported lab's study is loaded",
    underGrant.length === 1 && underGrant[0] === "Cage subsidence", underGrant);
  ev('viewWorkspace = ""; window.__p2 = pullAll();');
  await w.__p2;
  await wait(200);
  check("leaving it restores both her labs",
    JSON.parse(ev("JSON.stringify(state.studies.map(s => s.title))")).length === 2);

  console.log("\n-- The database rule matches the app --");
  if (!haveSql) {
    console.log("  skipped — supabase/migrations isn't in this checkout");
  } else {
  const sql = fs.readFileSync(path.join(SQL_DIR, "008-multi-lab-membership.sql"), "utf8");
  check("there's a set-returning my_workspaces()", /returns setof text/.test(sql));
  check("all four items policies compare with `in`, not `=`",
    (sql.match(/workspace in \(select public\.my_workspaces\(\)\)/g) || []).length >= 4,
    (sql.match(/workspace in \(select public\.my_workspaces\(\)\)/g) || []).length);
  check("no policy still uses `workspace = public.my_workspace()`",
    !/workspace = public\.my_workspace\(\)/.test(sql));
  // Insert deliberately narrower than read: support access lets you FIX a lab's records, not
  // author new ones in it.
  const insertClause = sql.slice(sql.indexOf('create policy "workspace insert"'), sql.indexOf('create policy "workspace update"'));
  check("insert does not grant authoring under support access",
    !/has_support_access/.test(insertClause), insertClause);
  check("membership is writable only by an app admin",
    /create policy lab_members_write[\s\S]{0,200}is_app_admin\(\)/.test(sql));
  check("it is seeded from existing profiles, so day one is a no-op",
    /insert into public\.lab_members[\s\S]{0,300}from public\.items/.test(sql));
  check("...idempotently", /on conflict \(user_id, workspace\) do nothing/.test(sql));
  check("my_workspaces falls back to the profile, so nobody is locked out",
    /union[\s\S]{0,200}kind = 'profile'/.test(sql));
  check("nothing is dropped or deleted", !/drop table|delete from/i.test(sql),
    (sql.match(/drop table.*|delete from.*/i) || [])[0]);
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
