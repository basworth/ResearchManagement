// Break-glass support access — 15 Oct 2026.
//
// Adam chose this over sealing the labs from himself entirely, so that he can still fix things in
// somebody else's lab. The whole bargain is that getting in is never silent. So the things worth
// holding here are mostly about VISIBILITY, and one about safety:
//
//   * the supported lab sees a banner naming who is in, why, and until when — undismissable
//   * Adam sees his own banner while he's in there, because the app otherwise looks identical and
//     that is exactly how you edit the wrong lab's study
//   * a reason is required; "no reason given" on somebody's banner is worse than being made to type
//   * the lab on screen never changes which lab Adam BELONGS to — the stamp on his own profile row
//     stays his own, whatever he's looking at
//
// That last one is the dangerous one. His profile row is what my_workspace() reads, so stamping it
// with the lab he happens to be viewing would move him into Kern's workspace and lock him out of
// his own 119 studies. The database would permit it — he has support access, so the policy says
// yes — and nothing would look wrong until everything did.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const ADAM = "test-user-1";
const now = new Date().toISOString();
const soon = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
const past = new Date(Date.now() - 60 * 1000).toISOString();

const prof = (id, name, ws, extra) => ({
  id, kind: "profile", updated_at: now, workspace: ws,
  data: Object.assign({ id, email: name.toLowerCase().replace(/\W/g, "") + "@example.com", name,
    position: "Clinician", reportsTo: "", alertEmail: "", alertEmailAsked: true,
    degreesAsked: true, tourSeen: 1, linkedTo: "" }, extra || {}),
});
const study = (id, title, ws) => ({
  id, kind: "study", updated_at: now, workspace: ws,
  data: { id, title, design: "Prospective (Consented)", phase: "Analysis", priority: "Medium" },
});

function boot(opts) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase(opts) };
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
const bannerText = (w) => (w.document.getElementById("ws-banner") || {}).textContent || "";

(async () => {
  // ------------------------------------------------- the lab being looked at
  console.log("\n-- The lab being looked at is told, by name --");
  const spineItems = [prof(ADAM, "Priya Raman", "spine-singh"), study("s1", "Cage subsidence", "spine-singh")];
  const grants = [{
    id: "g1", grantee: "adam-id", workspace: "spine-singh",
    reason: "Looking into why task reminders aren't arriving",
    created_at: now, expires_at: soon, ended_at: null,
    grantee_name: "Adam Yanke", grantee_email: "adam.yanke@rushortho.com",
  }];
  const w = boot({ items: spineItems, tables: { support_grants: grants } });
  await wait(600);
  const t = bannerText(w);
  check("a banner is showing", !!t.trim(), t);
  check("...and it names him", /Adam Yanke/.test(t), t);
  check("...and gives the reason he typed", /task reminders aren't arriving/.test(t), t);
  check("...and says when it ends", /ends at/i.test(t), t);
  check("there's no way to dismiss it",
    w.document.querySelectorAll("#ws-banner button").length === 0);

  console.log("\n-- A grant that has ended says nothing --");
  const w2 = boot({ items: spineItems, tables: { support_grants: [
    Object.assign({}, grants[0], { id: "g2", ended_at: past }),
  ] } });
  await wait(600);
  check("no banner", !bannerText(w2).trim(), bannerText(w2));

  const w3 = boot({ items: spineItems, tables: { support_grants: [
    Object.assign({}, grants[0], { id: "g3", expires_at: past }),
  ] } });
  await wait(600);
  check("...nor for one that has expired", !bannerText(w3).trim(), bannerText(w3));

  // ------------------------------------------------- Adam's side
  console.log("\n-- Adam has to give a reason, and can't extend --");
  const adamItems = [
    prof(ADAM, "Adam Yanke", "sports-yanke", { admin: true }),
    study("y1", "Cartilage restoration outcomes", "sports-yanke"),
  ];
  const wa = boot({
    items: adamItems,
    tables: { support_grants: [] },
    rpcs: { list_workspaces: () => [
      { workspace: "sports-yanke", people: 1, studies: 1 },
      { workspace: "spine-singh", people: 4, studies: 11 },
    ] },
  });
  await wait(600);
  const ev = (c) => wa.eval(c);

  ev("openSupportSheet()");
  await wait(250);
  const sheet = wa.document.querySelector(".sheet-body").textContent;
  check("the labs are listed", /spine-singh/.test(sheet), sheet.slice(0, 200));
  check("...with counts only, no project titles",
    /4 people/.test(sheet) && !/Cage subsidence/.test(sheet), sheet.slice(0, 300));
  check("...and his own lab isn't offered", !/sports-yanke/.test(sheet));

  ev('askForSupportAccess("spine-singh")');
  await wait(450);
  check("the reason box is the first thing", !!wa.document.getElementById("sa-reason"));
  // An empty or token reason is refused rather than defaulted — see the note in the sheet.
  wa.document.getElementById("sa-reason").value = "fixing";
  wa.document.getElementById("sheet-save").click();
  await wait(150);
  check("a token reason is refused — nothing was issued",
    wa.eval("supportGrants.length") === 0, wa.eval("JSON.stringify(supportGrants)"));
  check("...and the sheet stays open so the text isn't lost", !!wa.document.getElementById("sa-reason"));

  wa.document.getElementById("sa-reason").value = "Checking why Priya's reminders bounce";
  wa.document.getElementById("sheet-save").click();
  await wait(400);
  const issued = wa.eval("JSON.stringify(supportGrants)");
  const g = JSON.parse(issued)[0];
  check("a grant was issued", !!g, issued);
  check("...carrying his name, so their banner can say who", g && g.grantee_name === "Adam Yanke", g);
  check("...and the reason he typed", g && /Priya's reminders/.test(g.reason), g);
  check("...with an expiry in the future", g && g.expires_at > new Date().toISOString(), g && g.expires_at);

  console.log("\n-- Going in is obvious, and leaving puts him back --");
  await wa.eval('enterSupportedWorkspace("spine-singh")');
  await wait(300);
  check("he's viewing their lab", ev("viewWorkspace") === "spine-singh", ev("viewWorkspace"));
  check("...and told so, in a banner he can see", /not your own lab/i.test(bannerText(wa)), bannerText(wa));
  check("...but he still BELONGS to his own", ev("myWorkspace") === "sports-yanke", ev("myWorkspace"));

  console.log("\n-- The stamp on his own profile never follows the view --");
  // The dangerous case: his profile row is what my_workspace() reads. Stamping it with the lab on
  // screen would move him into theirs and lock him out of his own studies.
  check("his own profile still stamps as his lab",
    ev(`stampFor("profile", ${JSON.stringify(ADAM)})`) === "sports-yanke",
    ev(`stampFor("profile", ${JSON.stringify(ADAM)})`));
  check("...while a study he edits there belongs to them",
    ev('stampFor("study", "s1")') === "spine-singh", ev('stampFor("study", "s1")'));
  check("...and somebody else's profile in that lab belongs to them",
    ev('stampFor("profile", "someone-else")') === "spine-singh");

  console.log("\n-- Seeding the server is refused while he's in there --");
  // pushAllLocal writes this device's whole local copy stamped as mine — which, from inside
  // another lab, would copy their entire dataset into his own workspace.
  await wa.eval("pushAllLocal()");
  await wait(100);
  check("pushAllLocal declined", ev("viewWorkspace") === "spine-singh");

  console.log("\n-- Leaving, and access ending by itself --");
  await wa.eval("leaveSupportedWorkspace()");
  await wait(300);
  check("back in his own lab", ev("viewWorkspace") === "", ev("viewWorkspace"));

  await wa.eval('enterSupportedWorkspace("spine-singh")');
  await wait(300);
  check("in again", ev("viewWorkspace") === "spine-singh");
  // Expire it behind his back, the way a real grant lapses mid-session. It has to be changed in
  // the fake DATABASE, not in the app's copy — loadSupportGrants re-reads from the server, so a
  // local edit would simply be overwritten and the test would prove nothing.
  wa.eval(`(function(){ sb.__tables.support_grants[0].expires_at = ${JSON.stringify(past)}; })()`);
  await wa.eval("loadSupportGrants()");
  await wait(100);
  check("a lapsed grant drops him back on its own", ev("viewWorkspace") === "", ev("viewWorkspace"));

  console.log("\n-- An older database without migration 002 still works --");
  // list_workspaces and the grant columns arrive in 002. If the app ships first, it must degrade
  // to "no banner", not to "no app".
  const wOld = boot({ items: adamItems, tables: {}, rpcs: {} });
  await wait(600);
  check("the app still loaded", wOld.eval("state.studies.length") === 1);
  check("...with no banner", !bannerText(wOld).trim());
  wOld.eval("openSupportSheet()");
  await wait(250);
  check("...and asking for access says so rather than breaking",
    !wOld.document.querySelector(".sa-ask"));

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
