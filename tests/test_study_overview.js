// Study overview card — 10 Nov 2026.
// Written by the study-overview function from forwarded meetings; shown on the study page; a hand
// edit is marked so the next automatic rewrite leaves it alone.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const U = "test-user-1", S = "aaaaaaaa-0000-0000-0000-0000000000a1", S2 = "aaaaaaaa-0000-0000-0000-0000000000a2";
const st = (id, extra) => ({ id, kind: "study", updated_at: now, workspace: "sports-yanke", data: Object.assign({ id, title: "T " + id, pi: "Adam Yanke", team: ["Adam Yanke"], phase: "Analysis", milestones: [] }, extra || {}) });
const items = [
  { id: U, kind: "profile", updated_at: now, workspace: "sports-yanke", data: { id: U, name: "Adam Yanke", email: "a@b.c", position: "Clinician", admin: true, alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 999, fieldsChosen: true } },
  st(S, { overview: { purpose: "We're asking whether X.", relevance: "It changes Y.", status: "Enrolling.", nextSteps: "", meetings: 3, generatedAt: "2026-11-10T12:00:00Z", auto: true } }),
  st(S2),
];
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) { win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }); win.confirm = () => true; win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items }) }; } });
const w = dom.window, d = w.document;
let pass = 0, fail = 0;
const check = (n, c, x) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, x === undefined ? "" : "->" + JSON.stringify(x)), fail++);
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await wait(700); w.eval("syncOnline = true;");
  w.eval(`tab = "studies"; openStudy(${JSON.stringify(S)}); render()`); await wait(50);
  const t = d.getElementById("main").textContent;
  check("the overview shows on the study page", /What we're asking/.test(t) && /We're asking whether X\./.test(t) && /Why it matters/.test(t));
  check("an empty part is left out", !/What's next/.test(t));
  check("it says where it came from", /from 3 research meetings/.test(t), t.match(/written[^.]*/));
  check("an admin can rewrite it", !!d.getElementById("ov-refresh"));
  d.getElementById("ov-edit").click(); await wait(20);
  const ta = d.querySelector('[data-ov-field="status"]'); ta.value = "Enrolling — 40 of 60.";
  d.getElementById("ov-save").click(); await wait(30);
  const o = JSON.parse(w.eval(`JSON.stringify(studyById(${JSON.stringify(S)}).overview)`));
  check("an edit is saved and marked as a hand edit", o.status === "Enrolling — 40 of 60." && o.editedBy === "Adam Yanke" && !!o.editedAt, o);
  check("...and says so", /edited by Adam Yanke/.test(d.getElementById("main").textContent));
  w.eval(`openStudy(${JSON.stringify(S2)}); render()`); await wait(30);
  check("a study without one offers to write it", /No overview yet/.test(d.getElementById("main").textContent) && /Write from meetings/.test(d.getElementById("ov-refresh").textContent));
  const src = fs.existsSync(PROJECT + "/supabase/functions/study-overview/index.ts") ? fs.readFileSync(PROJECT + "/supabase/functions/study-overview/index.ts", "utf8") : "";
  if (src) {
    check("server: a hand edit is never overwritten without force", /s\.overview && s\.overview\.editedBy && !body\.force/.test(src));
    check("server: patient details are scrubbed again", /export function scrub/.test(src) && /scrub\(d\.text/.test(src));
    check("server: only the email reader, app admin or that lab's admin may call it", /x-ingest-secret/.test(src) && /app_admins/.test(src) && /allowedLabs\.indexOf\(r\.workspace\) < 0/.test(src));
  }
  const ing = fs.existsSync(PROJECT + "/supabase/functions/ingest-email/index.ts") ? fs.readFileSync(PROJECT + "/supabase/functions/ingest-email/index.ts", "utf8") : "";
  // main carries an old copy of the function source; only check the current one (fn-deploy).
  if (ing && /attachedEmails/.test(ing)) check("every forwarded meeting refreshes the overviews of the studies it changed", /functions\/v1\/study-overview/.test(ing) && /record\.studyIds\.slice\(0, 25\)/.test(ing));
  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
