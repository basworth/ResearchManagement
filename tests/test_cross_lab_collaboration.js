// Collaborators see a study wherever it lives — 19 Oct 2026.
//
// A study carries one lab label forever, and reading it has required membership of that lab. So
// once Chahla has his own lab, a study of his that Adam is an investigator on would be invisible
// to Adam. This adds a second door: named on it, you can read it, whichever lab it sits in.
//
// The door is deliberately narrower than the one inside a lab, and both narrowings are the point:
//
//   1. FULL NAME ONLY. Inside a lab, "Haboba" matching "Haboba C" in an author list is a
//      convenience. Across a boundary it is a leak — two different Coles in two different labs
//      would read each other's work. These tests pin that surname alone does NOT cross.
//
//   2. TEAM AND PI ONLY, NEVER THE AUTHOR LIST. Co-authorship grants access inside a lab, which
//      is why Cole reaches 186 of 397 in Adam's. Carrying that across would hand every co-author
//      a new lab's entire published back-catalogue on the day it was created. Being added to the
//      work is collaboration; having been credited once is history.
//
// The third thing worth testing is that the client agrees with the server. The row arrives from
// the database and is then filtered again locally; if only one side knows the rule, the feature
// looks broken in a way that no error message explains.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

// The mock signs in as this id; a profile row under any other id simply is not "me", and every
// collaborator check would silently return false.
const ME = "test-user-1";
const now = new Date().toISOString();
const profile = () => ({
  id: ME, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: { id: ME, email: "a@example.com", name: "Adam Yanke", position: "Clinician",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true,
    tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: true },
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
  const is = (d) => ev(`isCollaboratorOn(${JSON.stringify(d)})`);

  console.log("\n-- Named on it, from anywhere --");
  check("on the Team", is({ team: ["Jorge Chahla", "Adam Yanke"] }) === true);
  check("as the PI", is({ pi: "Adam Yanke" }) === true);
  check("Team entry with stray whitespace", is({ team: ["  Adam Yanke  "] }) === true);
  check("case doesn't matter", is({ team: ["ADAM YANKE"] }) === true);

  console.log("\n-- Surname alone does NOT cross a lab boundary --");
  // Inside a lab this would match. Across one it must not: two Coles in two labs would otherwise
  // read each other's studies.
  check("surname on the Team", is({ team: ["Yanke"] }) === false, "team:[Yanke]");
  check("surname as PI", is({ pi: "Yanke" }) === false);
  check("initials form", is({ team: ["Yanke AB"] }) === false);
  check("a longer name containing mine", is({ team: ["Adam Yankee"] }) === false);
  check("my name inside a sentence", is({ pi: "Adam Yanke and others" }) === false);

  console.log("\n-- Author credit does NOT cross --");
  // The asymmetry that keeps a new lab's back-catalogue in that lab.
  check("publication authors don't count",
    is({ publication: { authors: [{ fore: "Adam", last: "Yanke" }] } }) === false);
  check("authorList doesn't count",
    is({ publication: { authorList: "Yanke AB, Chahla J" } }) === false);
  check("top-level authors don't count",
    is({ authors: [{ fore: "Adam", last: "Yanke" }] }) === false);
  check("...but Team on the same study does",
    is({ team: ["Adam Yanke"], publication: { authorList: "Chahla J" } }) === true);

  console.log("\n-- Nothing degenerate matches everything --");
  const NASTY = [null, undefined, {}, { team: null }, { team: "Adam Yanke" }, { team: 42 },
                 { pi: null }, { team: [null, undefined] }, { team: [""] }, { pi: "" }];
  NASTY.forEach((d, i) => {
    let threw = null, r = null;
    try { r = is(d); } catch (e) { threw = String(e); }
    check("  shape " + i + " doesn't throw", !threw, threw);
    check("    ...and doesn't match", r === false, r);
  });
  // A legacy string team is NOT split cross-lab: exact array entries only. Being strict here is
  // the safe direction — worst case somebody doesn't see a study and says so.
  check("a legacy comma string doesn't match loosely",
    is({ team: "Adam Yanke, Jorge Chahla" }) === false);

  console.log("\n-- A blank name is never a wildcard --");
  ev(`state.profiles = [{ id: "${ME}", name: "", admin: true }];`);
  check("empty profile name matches nothing", is({ team: ["Adam Yanke"] }) === false);
  ev(`state.profiles = [{ id: "${ME}", name: "   ", admin: true }];`);
  check("whitespace profile name matches nothing", is({ team: ["Adam Yanke"] }) === false);
  ev(`state.profiles = [{ id: "${ME}", name: "Adam Yanke", admin: true }];`);
  check("a real name works again", is({ team: ["Adam Yanke"] }) === true);

  console.log("\n-- The client filter keeps what the server sends --");
  check("pullAll keeps cross-lab studies", /isCollaboratorOn\(r\.data\)/.test(html));
  check("...only for studies", /r\.kind === "study" && isCollaboratorOn/.test(html));
  check("...and never while in a support-access view", /!viewWorkspace && r\.kind === "study"/.test(html),
    (html.match(/.{0,80}isCollaboratorOn\(r\.data\).{0,40}/) || [])[0]);

  console.log("\n-- The migration --");
  const MIG = path.join(PROJECT, "supabase", "migrations", "012-cross-lab-collaboration.sql");
  if (!fs.existsSync(MIG)) {
    console.log("  (skipped — supabase/migrations isn't in this checkout)");
  } else {
    const sql = fs.readFileSync(MIG, "utf8");
    check("the strict matcher is its own function", /create or replace function public\.my_full_name/.test(sql));
    check("...kept separate from the loose one, on purpose", /Separate from my_names\(\) on purpose/.test(sql));
    check("it matches by equality, not substring", /lower\(trim\(v\)\) = \(select n from me\)/.test(sql));
    check("pi matched by equality too", /lower\(trim\(coalesce\(d->>'pi', ''\)\)\) = \(select n from me\)/.test(sql));
    check("a null name short-circuits to false", /is null or \(select n from me\) = '' then false/.test(sql));
    check("the author list is NOT consulted",
      !/is_collaborator[\s\S]{0,700}?publication/.test(sql),
      (sql.match(/function public\.is_collaborator[\s\S]{0,700}/) || [])[0]);
    check("the new branch only adds", /or \(\s*\n\s*kind = 'study'\s*\n\s*and \(public\.is_collaborator/.test(sql));
    check("the inside-a-lab branch is unchanged",
      /public\.is_involved\(data\)[\s\S]{0,120}assigned_on_study\(id::text\)/.test(sql));
    check("writes are not widened", /does not grant: insert or delete/i.test(sql));
    check("it says how to roll back", /ROLLBACK:/.test(sql));
    check("VERIFY proves surnames don't cross", /Surname alone must not cross a lab boundary/.test(sql));
    check("VERIFY proves author credit doesn't cross", /author-credit exclusion/.test(sql));
    check("VERIFY checks nothing goes down", /Nobody's count goes DOWN/.test(sql));
  }

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
