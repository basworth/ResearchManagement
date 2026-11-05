// Deadline cards show what the acceptance emails said — 5 Nov 2026.
// Adam, on the ORS 2027 card: studies the forwarded ORS emails had marked "Accepted · Poster" still
// said Submitted, because the card read only the per-deadline status and the emails update the
// study's Abstracts list.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const U = "test-user-1";
const ORS = "a04d953b-00bd-408b-8206-e8e1fdab0d03";
const st = (id, extra) => ({ id, kind: "study", updated_at: now, workspace: "sports-yanke",
  data: Object.assign({ id, title: "T " + id, pi: "Adam Yanke", team: ["Adam Yanke"], phase: "Analysis", milestones: [] }, extra) });
const items = [
  { id: U, kind: "profile", updated_at: now, workspace: "sports-yanke", data: { id: U, name: "Adam Yanke", email: "a@b.c", position: "Clinician", admin: true,
    alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 999, fieldsChosen: true } },
  st("emailed", { abstractDeadlineInfo: { [ORS]: { format: "Poster", status: "Submitted", acceptedFormat: "" } },
    abstracts: [{ id: "x1", meeting: "ORS 2027", date: "2026-11-05", status: "Accepted", format: "Poster" }] }),
  st("oldyear", { abstractDeadlineInfo: { [ORS]: { format: "Poster", status: "Submitted", acceptedFormat: "" } },
    abstracts: [{ id: "x2", meeting: "ORS 2026", date: "2025-11-05", status: "Accepted", format: "Poster" }] }),
  st("otherMeeting", { abstractDeadlineInfo: { [ORS]: { status: "Submitted" } },
    abstracts: [{ id: "x3", meeting: "AAOS 2027", date: "2026-11-04", status: "Rejected" }] }),
  st("handLater", { abstractDeadlineInfo: { [ORS]: { status: "Submitted", statusSetAt: "2026-11-06T10:00:00Z" } },
    abstracts: [{ id: "x4", meeting: "ORS 2027", date: "2026-11-05", status: "Accepted", format: "Podium" }] }),
  st("noEmail", { abstractDeadlineInfo: { [ORS]: { status: "Submitted" } } }),
];
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true; win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items }) };
  } });
const w = dom.window;
let pass = 0, fail = 0;
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);
(async () => {
  await new Promise(r => setTimeout(r, 700));
  w.eval(`if (!state.meetings.some(m => m.id === ${JSON.stringify(ORS)})) state.meetings.push({ id: ${JSON.stringify(ORS)}, society: "ORS", name: "ORS 2027 Annual Meeting", type: "abstract", deadline: "2026-08-31", dates: "Feb 19–23, 2027" });`);
  const info = (id) => JSON.parse(w.eval(`JSON.stringify(abstractLinkInfo(studyById(${JSON.stringify(id)}), ${JSON.stringify(ORS)}))`));
  check("an acceptance email for 'ORS 2027' shows Accepted on the ORS 2027 card", info("emailed").status === "Accepted" && info("emailed").acceptedFormat === "Poster", info("emailed"));
  check("...but a different year doesn't", info("oldyear").status === "Submitted", info("oldyear"));
  check("...nor a different meeting", info("otherMeeting").status === "Submitted", info("otherMeeting"));
  check("a status set by hand after the email stands", info("handLater").status === "Submitted", info("handLater"));
  check("no email: unchanged", info("noEmail").status === "Submitted");
  check("setting the status by hand records when", (() => { w.eval(`setAbstractLinkField(studyById("noEmail"), ${JSON.stringify(ORS)}, "status", "Accepted")`); return !!info("noEmail").statusSetAt; })());
  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
