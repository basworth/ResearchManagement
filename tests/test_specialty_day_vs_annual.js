// AANA Annual Meeting vs AOSSM/AANA Specialty Day (23 Nov 2026). Adam: "some might have gotten
// confused between AANA and the AANA/AOSSM specialty day". An "AANA 2027" e-poster acceptance
// matched both deadlines, because every word of it is in the Specialty Day's name.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const U = "test-user-1";
const items = [{ id: U, kind: "profile", updated_at: now, workspace: "sports-yanke", data: { id: U, name: "Adam Yanke", email: "a@b.c", position: "Clinician", admin: true, alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 999, fieldsChosen: true } }];
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) { win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }); win.confirm = () => true; win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items }) }; } });
const w = dom.window;
let pass = 0, fail = 0;
const check = (n, c, x) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, x === undefined ? "" : "->" + JSON.stringify(x)), fail++);
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await wait(700);
  const r = JSON.parse(w.eval(`(function(){
    var annual = { id: "m1", society: "AANA", key: "AANA|2027 Annual Meeting", name: "2027 Annual Meeting", dates: "2027" };
    var sday = { id: "m2", society: "AOSSM", key: "AOSSM|2027 Specialty Day", name: "AOSSM/AANA 2027 Specialty Day Meeting", dates: "March 6, 2027" };
    var poster = { abstracts: [{ meeting: "AANA 2027", status: "Accepted", format: "E-Poster", date: "2026-11-19" }] };
    var sd = { abstracts: [{ meeting: "AOSSM/AANA Specialty Day 2027", status: "Accepted", format: "Podium", date: "2026-12-01" }] };
    return JSON.stringify({
      posterAnnual: !!abstractEntryForDeadline(poster, annual), posterSday: !!abstractEntryForDeadline(poster, sday),
      sdSday: !!abstractEntryForDeadline(sd, sday), sdAnnual: !!abstractEntryForDeadline(sd, annual) });
  })()`));
  check("an AANA 2027 acceptance belongs to the AANA Annual Meeting", r.posterAnnual, r);
  check("...and not to the AOSSM/AANA Specialty Day", !r.posterSday, r);
  check("a Specialty Day acceptance belongs to Specialty Day", r.sdSday, r);
  check("...and not to the AANA Annual Meeting", !r.sdAnnual, r);
  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
