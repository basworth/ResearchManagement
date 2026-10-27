// Balloon tour — 27 Oct 2026.
//
// Adam: "can you make little balloons pop up when people first log in highlighting each section of
// the site, what it does, and how to customize it?"
//
// What these tests hold:
//   1. It follows the sheet tour for a new account, and runs alone, once, for someone who has
//      already seen the sheet tour.
//   2. Each balloon says what the section does AND how to make it yours.
//   3. A step whose control isn't on screen is skipped, never shown pointing at nothing.
//   4. Done, Skip and Escape all count as seen, recorded on the profile.
//   5. It can be brought back from Help.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const USER = "test-user-1";
const now = new Date().toISOString();
const profile = (extra) => ({
  id: USER, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: Object.assign({ id: USER, email: "t@example.com", name: "Alex Rivera", position: "Research assistant",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true, linkedTo: "", fieldsChosen: true }, extra || {}),
});
// jsdom lays nothing out, so every element measures 0×0. Give everything a box, except what a
// test wants hidden.
function boot(items, hidden) {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.Element.prototype.getBoundingClientRect = function () {
        if ((hidden || []).some(sel => this.matches(sel))) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
        return { left: 100, top: 700, right: 160, bottom: 740, width: 60, height: 40 };
      };
      win.supabase = { createClient: () => makeMockSupabase({ items }) };
    } });
  return dom.window;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}
const title = (w) => { const h = w.document.querySelector("#balloon h3"); return h ? h.textContent : null; };

(async () => {
  console.log("\n-- Someone who has seen the sheet tour gets the balloons, once --");
  const w = boot([profile({ tourSeen: 1 })], ["#sidebar:not(.collapsed)", "#sidebar"]);
  await wait(800);
  check("a balloon is up", !!w.document.getElementById("balloon"));
  check("no sheet stacked under it", !w.document.getElementById("sheet"));
  check("the first one is the Dashboard", title(w) === "Dashboard", title(w));
  check("it rings the real control", !!w.document.getElementById("balloon-ring"));
  const t = w.document.getElementById("balloon").textContent;
  check("it says what the section does", /deadlines/.test(t));
  check("...and how to make it yours", /Make it yours:/.test(t) && /Deadline Subscriptions/.test(t));
  const seen = [];
  let guard = 0;
  while (w.document.getElementById("balloon") && guard++ < 20) {
    seen.push(title(w));
    w.document.getElementById("bl-next").click();
  }
  check("it walks every section", JSON.stringify(seen) === JSON.stringify(["Dashboard", "Studies", "Tasks", "Worklist",
    "Meeting notes", "My Lab", "Settings", "Add", "Help", "Suggest a change"]), seen);
  check("every step tells you how to customize it", w.eval("balloonSteps().every(s => s.what && s.custom)"));
  check("Done records it on the profile", w.eval(`(profileFor("${USER}") || {}).balloonsSeen`) === 1);
  check("the + it revealed on My Lab is hidden again", w.eval('tab') !== "research" || w.document.getElementById("add-btn").style.visibility === "hidden", w.eval('tab'));
  check("the tour never changes your tab", w.eval('tab') === "research", w.eval('tab'));
  check("...and the ring is gone", !w.document.getElementById("balloon-ring") && !w.document.getElementById("balloon-catch"));
  w.eval("maybeShowTour()");
  check("it doesn't come back", !w.document.getElementById("balloon"));

  console.log("\n-- Back works, and a missing control is skipped --");
  const w2 = boot([profile({ tourSeen: 1 })], ["#sidebar:not(.collapsed)", "#sidebar", 'nav.tabbar [data-tab="worklist"]']);
  await wait(800);
  check("the phone dashboard tab stands in for the sidebar", title(w2) === "Dashboard");
  check("no Back on the first", !w2.document.getElementById("bl-back"));
  w2.document.getElementById("bl-next").click(); w2.document.getElementById("bl-next").click();
  check("on Tasks", title(w2) === "Tasks", title(w2));
  w2.document.getElementById("bl-next").click();
  check("Worklist isn't on screen, so it goes straight to Meeting notes", title(w2) === "Meeting notes", title(w2));
  w2.document.getElementById("bl-back").click();
  check("...and back skips it too", title(w2) === "Tasks", title(w2));
  check("the count leaves it out", /3 of 9/.test(w2.document.querySelector(".bl-count").textContent), w2.document.querySelector(".bl-count").textContent);
  w2.document.getElementById("bl-skip").click();
  check("Skip closes it", !w2.document.getElementById("balloon"));
  check("...and counts as seen", w2.eval(`(profileFor("${USER}") || {}).balloonsSeen`) === 1);

  console.log("\n-- Escape counts as seen --");
  const w3 = boot([profile({ tourSeen: 1 })]);
  await wait(800);
  w3.document.dispatchEvent(new w3.KeyboardEvent("keydown", { key: "Escape" }));
  check("Escape closes it", !w3.document.getElementById("balloon"));
  check("...and records it", w3.eval(`(profileFor("${USER}") || {}).balloonsSeen`) === 1);

  console.log("\n-- Already seen: nothing --");
  const w4 = boot([profile({ tourSeen: 1, balloonsSeen: 1 })]);
  await wait(800);
  check("no balloon", !w4.document.getElementById("balloon"));
  console.log("\n-- Brought back from Help --");
  w4.eval("openHelpSheet()");
  w4.document.getElementById("help-balloons").click();
  await wait(450);
  check("Point things out reopens it", title(w4) === "Dashboard", title(w4));

  console.log("\n-- A brand-new account: the sheet tour first, then the balloons --");
  const w5 = boot([profile()]);
  await wait(800);
  check("the sheet tour opens first", !!w5.document.getElementById("sheet") && !w5.document.getElementById("balloon"));
  let g = 0;
  while (w5.document.getElementById("tour-next") && g++ < 10) w5.document.getElementById("tour-next").click();
  await wait(600);
  check("then the balloons", title(w5) === "Dashboard", title(w5));

  console.log("\n-- Nothing measurable: no tour, no stranded overlay --");
  const w6 = boot([profile({ tourSeen: 1 })], ["*"]);
  await wait(800);
  check("nothing shown", !w6.document.getElementById("balloon") && !w6.document.getElementById("balloon-catch"));

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
