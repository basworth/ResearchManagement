// A forward's covering note stops at the sign-off (23 Nov 2026): a signature is not a note.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) { win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }); win.confirm = () => true; win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items: [] }) }; } });
const w = dom.window;
let pass = 0, fail = 0;
const check = (n, c, x) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, x === undefined ? "" : "->" + JSON.stringify(x)), fail++);
const cn = (t) => w.eval(`coveringNote(${JSON.stringify(t)})`);
setTimeout(() => {
  const tail = "\n\nFrom: Journal <x@y.z>\nSubject: Reminder\n\nDear Dr";
  check("a signature alone is not a note", cn("Best,\nThomas (TJ) Turinske and William Lee\nSports Medicine Research Fellows to Adam Yanke, MD, PhD\nMidwest Orthopaedics at RUSH<https://www.rushortho.com/>\nP: 312 | RushOrtho.com" + tail) === "");
  check("the note above a sign-off is kept, the signature dropped", cn("Can you send the revision by Friday?\n\nBest regards,\nTJ Turinske\nResearch Fellow" + tail) === "Can you send the revision by Friday?");
  check("'Thanks, decline the transfer' is a note, not a sign-off", /decline the transfer/.test(cn("Thanks, decline the transfer and send to Cartilage" + tail)));
  check("Adam's plain note is untouched", cn("Was this one already submitted to and rejected from AJSM? IF so I would goto journal of knee surgery" + tail) === "Was this one already submitted to and rejected from AJSM? IF so I would goto journal of knee surgery");
  check("'Sent from my iPhone' is dropped", cn("FYI decline this one\n\nSent from my iPhone" + tail) === "FYI decline this one");
  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 700);
