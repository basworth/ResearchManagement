// Guided first run, the Help sheet, and "Something's wrong" — 15 Oct 2026.
//
// Built because a second lab is arriving with nobody to walk them through the app. Everyone using
// it so far learned it by sitting next to Adam, which is not a plan that scales to a team he
// doesn't work with.
//
// The things worth holding:
//   * the tour runs ONCE per account, and "seen" is recorded on the profile rather than in
//     localStorage — otherwise signing in on a phone after a laptop looks like the app forgot you
//   * skipping counts as seen (a tour you can't dismiss permanently is worse than no tour)
//   * it never stacks on top of the "who are you" sheet a brand-new account meets first
//   * Help is reachable from every screen, and says who can see what — the question a new lab
//     actually has
//   * "Something's wrong" opens the form already set to "a problem"
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const USER = "test-user-1";
const now = new Date().toISOString();

// A fully set-up account that has never seen the tour: name and role present, no tourSeen.
// `degreesAsked` matters — a Clinician who hasn't been asked for their letters gets the setup
// sheet instead, which is correct behaviour and would otherwise be read here as the tour failing.
const profile = (extra) => ({
  id: USER, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: Object.assign({
    id: USER, email: "test@example.com", name: "Alex Rivera", position: "Clinician",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true, linkedTo: "",
  }, extra || {}),
});

function boot(items) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items }) };
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
const sheetTitle = (w) => { const h = w.document.querySelector("#sheet h2"); return h ? h.textContent : null; };
const sheetText = (w) => { const b = w.document.querySelector(".sheet-body"); return b ? b.textContent : ""; };

(async () => {
  // ---------------------------------------------------------------- a set-up account, first time
  const items = [profile()];
  const w = boot(items);
  await wait(600);
  const ev = (code) => w.eval(code);

  console.log("\n-- A set-up account meets the walkthrough once --");
  check("the tour opened by itself", sheetTitle(w) === "Welcome", sheetTitle(w));
  check("...and leads with the rule about identifiable data",
    /nothing that identifies a patient/i.test(sheetText(w)));

  console.log("\n-- It steps forward and back --");
  w.document.getElementById("tour-next").click();
  await wait(50);
  check("Next moves on", sheetTitle(w) === "Projects", sheetTitle(w));
  w.document.getElementById("tour-back").click();
  await wait(50);
  check("Back returns", sheetTitle(w) === "Welcome", sheetTitle(w));
  check("there's no Back on the first step", !w.document.getElementById("tour-back"));

  console.log("\n-- It explains the thing a new lab actually asks --");
  // Walk to the isolation step and read it.
  let guard = 0;
  while (sheetTitle(w) !== "Who sees what" && guard++ < 10) {
    w.document.getElementById("tour-next").click();
    await wait(30);
  }
  check("there's a step on who can see what", sheetTitle(w) === "Who sees what", sheetTitle(w));
  const seeText = sheetText(w);
  check("...which says the database refuses, not that a filter hides",
    /database itself refuses/i.test(seeText));
  check("...and promises a banner if Adam ever gets in", /banner/i.test(seeText));
  check("...and is honest that the deadline calendar is shared",
    /deadline calendar/i.test(seeText));

  console.log("\n-- Finishing records it against the account, not the browser --");
  guard = 0;
  while (w.document.getElementById("tour-next") && !/Get started/.test(w.document.getElementById("tour-next").textContent) && guard++ < 10) {
    w.document.getElementById("tour-next").click();
    await wait(30);
  }
  w.document.getElementById("tour-next").click();
  // closeSheet animates out and removes the node 320ms later, so anything under that reads as
  // "still open" and the three checks below all fail for a reason that has nothing to do with them.
  await wait(450);
  check("the sheet closed", !w.document.getElementById("sheet"));
  check("the profile records it", ev(`(profileFor(${JSON.stringify(USER)}) || {}).tourSeen`) === 1,
    ev(`JSON.stringify(profileFor(${JSON.stringify(USER)}))`));
  const saved = items.find(r => r.id === USER);
  check("...and it reached the server, so another device knows too",
    saved && saved.data && saved.data.tourSeen === 1, saved && saved.data && saved.data.tourSeen);

  console.log("\n-- It does not come back --");
  ev("maybeShowTour()");
  await wait(50);
  check("a second call opens nothing", !w.document.getElementById("sheet"));

  console.log("\n-- Help is available from anywhere, and reopens the tour --");
  w.document.getElementById("help-btn").click();
  await wait(60);
  check("the ? button opens Help", sheetTitle(w) === "How this works", sheetTitle(w));
  check("Help lists every walkthrough topic",
    w.document.querySelectorAll(".help-head").length === ev("tourSteps().length"),
    [w.document.querySelectorAll(".help-head").length, ev("tourSteps().length")]);
  // Sections start closed so the sheet is a menu, not a wall of text.
  check("sections start closed", w.document.getElementById("help-body-0").style.display === "none");
  w.document.querySelector('.help-head[data-help="0"]').click();
  await wait(30);
  check("...and open when tapped", w.document.getElementById("help-body-0").style.display === "block");

  console.log("\n-- \"Something's wrong\" lands on the right form --");
  w.document.getElementById("help-problem").click();
  await wait(400);
  check("it opens the feedback sheet", sheetTitle(w) === "Something's wrong", sheetTitle(w));
  check("...already set to a problem",
    w.document.getElementById("fb-kind").value === "problem",
    w.document.getElementById("fb-kind").value);
  // The ordinary floating button still defaults to an idea — most people pressing it have one.
  ev("closeSheet(); openFeedbackSheet()");
  await wait(60);
  check("the plain button still defaults to an idea",
    w.document.getElementById("fb-kind").value === "idea");

  // ------------------------------------------------- an account that has already seen it
  console.log("\n-- An account that's seen it is left alone --");
  const w2 = boot([profile({ tourSeen: 1 })]);
  await wait(600);
  check("nothing opens on sign-in", !w2.document.getElementById("sheet"),
    w2.document.querySelector("#sheet h2") && w2.document.querySelector("#sheet h2").textContent);

  // ------------------------------------------------- a brand-new account with no name yet
  console.log("\n-- A brand-new account is asked who it is first --");
  const w3 = boot([]);
  await wait(600);
  const t3 = sheetTitle(w3);
  check("the setup prompt is what it meets", /tell us who you are/i.test(t3 || ""), t3);
  check("...and the tour hasn't stacked on top of it",
    w3.document.querySelectorAll("#sheet").length === 1,
    w3.document.querySelectorAll("#sheet").length);
  // The tour gets its turn once they have a name and a role — see maybeShowTour.
  check("the tour stands down while a sheet is open",
    w3.eval("(function(){ maybeShowTour(); return document.querySelector('#sheet h2').textContent; })()") === t3);

  console.log("\n-- Closing counts as seen too --");
  const w5 = boot([profile()]);
  await wait(600);
  check("the tour is up", sheetTitle(w5) === "Welcome", sheetTitle(w5));
  // Close and a stray tap on the backdrop are dismissals, not "ask me again next time". A
  // welcome that comes back every sign-in is a nag.
  w5.document.getElementById("sheet-cancel").click();
  await wait(450);
  check("Close closes it", !w5.document.getElementById("sheet"));
  check("...and records it", w5.eval(`(profileFor(${JSON.stringify(USER)}) || {}).tourSeen`) === 1);

  console.log("\n-- Skipping counts as seen --");
  const w4 = boot([profile()]);
  await wait(600);
  check("the tour is up", sheetTitle(w4) === "Welcome", sheetTitle(w4));
  w4.document.getElementById("tour-skip").click();
  await wait(450);
  check("skip closes it", !w4.document.getElementById("sheet"));
  check("...and records it, so it never nags again",
    w4.eval(`(profileFor(${JSON.stringify(USER)}) || {}).tourSeen`) === 1);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
