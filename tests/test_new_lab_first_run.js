// A new lab is asked which fields it works in — 19 Oct 2026.
//
// Written because the onboarding note for Kern contained a step that said, in effect, "tell him
// to go to Settings and untick ten things or his board opens with forty sports deadlines on it".
// A setup step a human has to remember to pass on is a defect with extra stages, so the app asks.
//
// The judgement calls worth protecting:
//   * only a PI setting up an EMPTY lab is asked. Everyone else — their colleagues, and every
//     established lab — is never interrupted, because their answer is already made.
//   * ticking nothing means "show me everything", not an empty board. An empty deadline board
//     with no explanation reads as a broken app rather than a choice.
//   * it's asked once and recorded on the profile, like the walkthrough.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const USER = "test-user-1";
const now = new Date().toISOString();
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

const profile = (extra) => ({
  id: USER, kind: "profile", updated_at: now, workspace: "spine-singh",
  data: Object.assign({ id: USER, email: "kern@example.com", name: "Kern Singh",
    position: "Clinician", reportsTo: "", alertEmail: "", alertEmailAsked: true,
    degreesAsked: true, tourSeen: 1, linkedTo: "", admin: true }, extra || {}),
});
const meeting = (id, society, deadline) => ({
  id, kind: "meeting", updated_at: now, workspace: "sports-yanke",
  data: { id, key: society + "|" + id, society, name: society + " meeting", type: "abstract",
    deadline, dates: "", location: "", link: "", aim: "", criteria: "", funded: [], studyIds: [],
    unconfirmed: false, verifiedOn: "2026-10-01T09:00" },
});
const study = () => ({
  id: "s1", kind: "study", updated_at: now, workspace: "spine-singh",
  data: { id: "s1", title: "Cage subsidence", design: "Prospective (Consented)", phase: "Analysis", priority: "Medium" },
});
const MEETINGS = [meeting("m1", "ICRS", inDays(30)), meeting("m2", "AANA", inDays(45)),
                  meeting("m3", "NASS", inDays(60)), meeting("m4", "AAOS", inDays(90))];

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
const title = (w) => { const h = w.document.querySelector("#sheet h2"); return h ? h.textContent : null; };

(async () => {
  console.log("\n-- A PI opening an empty lab is asked --");
  const kern = boot([profile()].concat(MEETINGS));
  await wait(700);
  check("the question comes up by itself", title(kern) === "Which fields do you work in?", title(kern));
  const rows = [...kern.document.querySelectorAll(".field-pick")].map(c => c.dataset.field);
  check("every field is offered", rows.length >= 11, rows.length);
  check("nothing is pre-ticked — it's a question, not a default",
    [...kern.document.querySelectorAll(".field-pick")].every(c => !c.checked));
  // Sorted by how much is tracked, so the likely answers are at the top rather than alphabetical.
  check("the fields carrying deadlines come first",
    ["Sports medicine", "Spine", "General orthopaedics"].every(f => rows.indexOf(f) < 4), rows.slice(0, 5));

  console.log("\n-- Choosing Spine leaves only spine deadlines --");
  const spineBox = kern.document.querySelector('.field-pick[data-field="Spine"]');
  spineBox.checked = true;
  kern.document.getElementById("sheet-save").click();
  await wait(400);
  check("recorded on the profile, so it is asked once",
    kern.eval(`(profileFor(${JSON.stringify(USER)}) || {}).fieldsChosen`) === true);
  check("Spine is on", kern.eval('fieldSubs()["Spine"]') === true);
  check("...and sports is off", kern.eval('fieldSubs()["Sports medicine"]') === false);
  kern.eval('tab = "dashboard"; render();');
  await wait(200);
  const board = kern.document.querySelector("#main").textContent;
  check("the board shows NASS", /NASS/.test(board));
  check("...and not the sports meetings", !/ICRS/.test(board) && !/AANA/.test(board), board.slice(0, 200));
  check("...with no field headings, since there's only one", kern.document.querySelectorAll(".field-head").length === 0);

  console.log("\n-- It does not come back --");
  kern.eval("maybeAskFields()");
  await wait(100);
  check("asking again opens nothing", !kern.document.getElementById("sheet"));

  console.log("\n-- Ticking nothing means everything, not an empty board --");
  // An empty deadline board with no explanation reads as broken, not as a choice.
  const shy = boot([profile()].concat(MEETINGS));
  await wait(700);
  check("the question is up", title(shy) === "Which fields do you work in?");
  shy.document.getElementById("sheet-save").click();
  await wait(400);
  check("it's recorded as answered", shy.eval(`(profileFor(${JSON.stringify(USER)}) || {}).fieldsChosen`) === true);
  check("every field is still on", shy.eval('fieldSubs()["Sports medicine"]') === true
                               && shy.eval('fieldSubs()["Spine"]') === true);
  shy.eval('tab = "dashboard"; render();');
  await wait(200);
  check("the board still has deadlines on it", /NASS/.test(shy.document.querySelector("#main").textContent));

  console.log("\n-- Nobody else is interrupted --");
  // An established lab: the PI has studies already, so the question is long past.
  const established = boot([profile(), study()].concat(MEETINGS));
  await wait(700);
  check("a lab with studies is left alone", !established.document.getElementById("sheet"),
    title(established));

  // A team member, not the PI. Their colleagues chose; asking them would be a regression.
  const member = boot([profile({ admin: false })].concat(MEETINGS));
  await wait(700);
  check("someone who doesn't run the lab is left alone", !member.document.getElementById("sheet"),
    title(member));

  // Someone who hasn't finished the name/role prompt yet mustn't get this stacked on top.
  const fresh = boot(MEETINGS);
  await wait(700);
  check("an account still being set up is asked who it is first",
    /tell us who you are/i.test(title(fresh) || ""), title(fresh));
  check("...and only one sheet is open", fresh.document.querySelectorAll("#sheet").length === 1);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
