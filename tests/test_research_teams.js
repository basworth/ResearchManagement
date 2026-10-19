// A PI's research team, and the line between a section and coverage — 19 Oct 2026.
//
// Two features that share one security boundary, so they're tested together.
//
// SECTION vs COVERAGE. Adam is in Sports. So are Chahla and Cole. That must grant him nothing:
// his standing instruction is that he should not see other PIs' studies at all. Only a row in
// division_coverage grants anything. The first draft of migration 009 merged these two ideas and
// would have handed Adam every Sports lab the moment a second one existed — the exact failure
// the whole multi-lab design exists to prevent. These assertions are the guard against it coming
// back.
//
// RESEARCH TEAMS. Will and TJ work for Adam, and may also work for Chahla. Team membership is
// lab membership, because a lab is one PI — so "everything of Adam's" and "everything in
// sports-yanke" are the same rows, and there is no second visibility mechanism to drift. What's
// new is that a PI, not only an app admin, may write those rows for their OWN lab.
//
// The sharp edge is `newRecordLab`: a study filed in the wrong PI's lab is close to undetectable,
// because it simply never appears for the person expecting it. So it must never move an existing
// row, never survive one save, and never be honoured for a lab the account isn't in.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const WILL = "u-will";
const now = new Date().toISOString();
const profile = () => ({
  id: WILL, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: { id: WILL, email: "will@example.com", name: "Will", position: "Coordinator",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true,
    tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: false },
});

function boot() {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items: [profile()] }) };
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
  const w = boot();
  await wait(600);
  const ev = (c) => w.eval(c);

  console.log("\n-- Being in a section grants nothing --");
  // Adam is in Sports and covers nothing. Sports contains three labs. He must still see one.
  ev(`myWorkspace = "sports-yanke"; myLabs = [];
      myDivisions = [];                       // coverage, which he has none of
      divisionLabs = {};
      allLabDivisions = [ { workspace: "sports-yanke", division: "sports" },
                          { workspace: "sports-chahla", division: "sports" },
                          { workspace: "sports-cole",  division: "sports" } ];`);
  const adamSees = JSON.parse(ev("JSON.stringify(labsIAmIn())"));
  check("he sees exactly his own lab", adamSees.join() === "sports-yanke", adamSees);
  check("not Chahla's", adamSees.indexOf("sports-chahla") < 0, adamSees);
  check("not Cole's", adamSees.indexOf("sports-cole") < 0, adamSees);
  check("the section list alone changes nothing",
    JSON.parse(ev("JSON.stringify(labsIAmIn())")).length === 1);

  console.log("\n-- Coverage is what grants --");
  ev(`myDivisions = ["sports"];
      divisionLabs = { sports: ["sports-yanke", "sports-chahla", "sports-cole"] };`);
  check("Carla sees all three", JSON.parse(ev("JSON.stringify(labsIAmIn())")).length === 3);

  console.log("\n-- newRecordLab: the study goes where it was told --");
  ev(`myWorkspace = "sports-yanke"; myLabs = ["sports-yanke", "sports-chahla"];
      myDivisions = []; divisionLabs = {}; remoteMeta = {}; newRecordLab = "";`);
  check("by default a new record lands in the primary lab",
    ev('stampFor("study", "brand-new-1")') === "sports-yanke", ev('stampFor("study", "brand-new-1")'));
  ev('newRecordLab = "sports-chahla";');
  check("choosing Chahla files it with Chahla",
    ev('stampFor("study", "brand-new-2")') === "sports-chahla", ev('stampFor("study", "brand-new-2")'));

  console.log("\n-- ...but never moves a record that already has a lab --");
  // The bug this guards: opening somebody's existing study and saving it would otherwise relocate
  // it, and nobody would notice until it vanished from their tracker.
  ev('remoteMeta["existing-1"] = { kind: "study", updated_at: "x", workspace: "sports-yanke" };');
  check("an existing row keeps its own stamp",
    ev('stampFor("study", "existing-1")') === "sports-yanke", ev('stampFor("study", "existing-1")'));

  console.log("\n-- ...and is never honoured for a lab you're not in --");
  ev('newRecordLab = "spine-singh";');
  check("an outside lab falls back to the active one",
    ev('stampFor("study", "brand-new-3")') === "sports-yanke", ev('stampFor("study", "brand-new-3")'));
  ev('newRecordLab = "";');

  console.log("\n-- ...and never survives one save --");
  check("it is cleared in a finally, not after upsertStudy returns",
    /try \{\s*upsertStudy\(s\);\s*\} finally \{\s*newRecordLab = "";/.test(html),
    (html.match(/newRecordLab = labSel[\s\S]{0,260}/) || [])[0]);
  check("it starts empty", ev('newRecordLab') === "");

  console.log("\n-- Your own profile is never relocated --");
  // A profile row following its owner into another lab would change who they are, not what
  // they're looking at.
  ev(`currentUser = { id: "${WILL}" }; newRecordLab = "sports-chahla";`);
  check("my profile still stamps with my own lab",
    ev(`stampFor("profile", "${WILL}")`) === "sports-yanke", ev(`stampFor("profile", "${WILL}")`));
  ev('newRecordLab = "";');

  console.log("\n-- The 'whose study' picker only appears when there's a real choice --");
  check("it's conditional on being in more than one lab",
    /!existing && labsIAmIn\(\)\.length > 1/.test(html));
  check("...and only for new studies, never on edit",
    !/existing && labsIAmIn\(\)\.length > 1/.test(html.replace(/!existing && labsIAmIn\(\)\.length > 1/g, "")));
  check("it says the choice is permanent", /can't be\s*\n?\s*changed afterwards/.test(html));

  console.log("\n-- piNameForLab says nothing rather than something wrong --");
  ev(`state.profiles = [{ id: "pi1", name: "Adam Yanke", admin: true },
                        { id: "p2",  name: "Will",       admin: false }];
      remoteMeta["pi1"] = { workspace: "sports-yanke" };
      remoteMeta["p2"]  = { workspace: "sports-yanke" };`);
  check("it finds the lab's PI", ev('piNameForLab("sports-yanke")') === "Adam Yanke", ev('piNameForLab("sports-yanke")'));
  check("a lab with no visible admin returns empty", ev('piNameForLab("spine-singh")') === "", ev('piNameForLab("spine-singh")'));
  check("no workspace returns empty", ev('piNameForLab("")') === "");
  check("undefined returns empty", ev('piNameForLab(undefined)') === "");
  check("a non-admin is never mistaken for the PI", ev('piNameForLab("sports-yanke")') !== "Will");

  console.log("\n-- The migrations --");
  const M9 = path.join(PROJECT, "supabase", "migrations", "009-divisions.sql");
  const M10 = path.join(PROJECT, "supabase", "migrations", "010-research-teams.sql");
  if (!fs.existsSync(M9) || !fs.existsSync(M10)) {
    console.log("  (skipped — supabase/migrations isn't in this checkout)");
  } else {
    const s9 = fs.readFileSync(M9, "utf8");
    const s10 = fs.readFileSync(M10, "utf8");

    check("coverage has its own table, named for what it does",
      /create table if not exists public\.division_coverage/.test(s9));
    check("the expansion reads coverage, not section membership",
      /from public\.division_coverage dc/.test(s9) && !/from public\.division_members/.test(s9));
    check("...and nothing seeds a coverage row", !/insert into public\.division_coverage/.test(s9));
    check("the header spells out that a section grants nothing",
      /grants NOTHING/.test(s9) && /must not let him see/i.test(s9));

    check("010 replaces the blanket admin-only write",
      /drop policy if exists lab_members_write on public\.lab_members/.test(s10));
    check("an app admin keeps full write", /lab_members_admin_write[\s\S]{0,200}is_app_admin\(\)/.test(s10));
    check("a lab admin may write only their own lab",
      /lab_members_lab_admin_write[\s\S]{0,300}using\s+\(public\.is_lab_admin\(\) and workspace = public\.my_workspace\(\)\)/.test(s10));
    check("...constrained on the way in as well as the way out",
      /lab_members_lab_admin_write[\s\S]{0,400}with check \(public\.is_lab_admin\(\) and workspace = public\.my_workspace\(\)\)/.test(s10));
    check("010 grants no admin", !/insert into public\.app_admins|is_app_admin\(\) returns/.test(s10));
    check("010 modifies no rows", !/update public\.items|delete from public\.items|update public\.lab_members/.test(s10));
    check("both carry a rollback", /ROLLBACK:/.test(s9) && /ROLLBACK:/.test(s10));
    check("both carry a VERIFY block", /VERIFY/.test(s9) && /VERIFY/.test(s10));
    check("010 verifies the cross-lab refusal explicitly",
      /CANNOT insert one for spine-singh/.test(s10));
  }

  console.log("\n-- The team sheet says what it does and doesn't do --");
  check("it says lab admins see everything of the PI's",
    /Your lab admins<\/b> see every study of yours/.test(html));
  check("...and that everyone else sees only their own work",
    /Everyone else<\/b> sees only the studies\s*\n?\s*they're on/.test(html));
  check("...and denies admin in the same breath",
    /Being here does not make someone an admin/.test(html));
  check("offboarding doesn't remove their work",
    /their own work stays where it is/.test(html)
    && /their work stays exactly where it is/.test(html));
  check("it writes source = 'team'", /source: "team"/.test(html));
  check("you can't remove yourself from your own lab", /r\.user_id !== meId/.test(html));

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
