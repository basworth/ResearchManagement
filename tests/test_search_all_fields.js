// Search looks at every field on a study — 26 Oct 2026.
//
// Adam: "the search function needs to take into account all fields, including grants etc." The
// old search read a hand-picked list (title, nickname, PI, IRB, team, journal, authors, PMID,
// DOI), so a study funded by OREF did not come up for "OREF". It now walks the whole record plus
// the study's task titles, requires every typed word (in any order), and leaves out ids,
// timestamps and uploaded file contents.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}
const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.supabase = { createClient: () => makeMockSupabase({ items: [] }) };
  },
});
const w = dom.window;

(async () => {
  await new Promise(r => setTimeout(r, 400));
  const study = {
    id: "s-cart", title: "Osteochondral allograft outcomes", nickname: "OCA", pi: "Adam Yanke", irb: "24-1234",
    phase: "Data Collection", design: "Retrospective",
    grant: { enabled: true, source: "OREF Career Development Grant", amount: "300000", awardDate: "2026-01-15" },
    notes: "Waiting on the Stryker budget before the next submission",
    docSlots: { other: [{ id: "d1", kind: "upload", label: "Figures v2", data: "data:application/pdf;base64,JVBERi0xLjQKJcfsj6IK" }] },
    updatedAt: "2026-10-26T10:00:00Z",
  };
  const other = { id: "s-hip", title: "Hip arthroscopy registry", pi: "Adam Yanke", phase: "Enrolling", design: "Prospective (Consented)",
    grant: { enabled: false, source: "", amount: "" } };
  w.eval(`state.studies = ${JSON.stringify([study, other])};
          state.tasks = [{ id: "t1", studyId: "s-hip", title: "Send DUA to Mayo", assignees: [] }];`);
  const m = (q) => w.eval(`state.studies.filter(s => studyMatchesSearch(s, ${JSON.stringify(q)})).map(s => s.id)`);

  console.log("\n-- Grants --");
  check("the grant's funder finds the study", JSON.stringify(m("OREF")) === '["s-cart"]', m("OREF"));
  check("the grant's amount finds it", JSON.stringify(m("300000")) === '["s-cart"]');
  console.log("\n-- Every other field, and the study's tasks --");
  check("free-text notes", JSON.stringify(m("stryker")) === '["s-cart"]');
  check("a document's description", JSON.stringify(m("figures v2")) === '["s-cart"]');
  check("a task on the study", JSON.stringify(m("mayo")) === '["s-hip"]');
  check("the old fields still work (IRB, title)", JSON.stringify(m("24-1234")) === '["s-cart"]' && JSON.stringify(m("registry")) === '["s-hip"]');
  console.log("\n-- Every word, any order --");
  check("two words both on the study match", JSON.stringify(m("career osteochondral")) === '["s-cart"]');
  check("two words on different studies match neither", m("oref registry").length === 0);
  console.log("\n-- What is deliberately not searched --");
  check("uploaded file contents are ignored", m("jvberi0xljq").length === 0);
  check("timestamps are ignored", m("10:00:00").length === 0);
  check("ids are ignored", m("s-cart").length === 0);
  console.log("\n-- Grant opportunities on the Deadlines side --");
  const mt = w.eval(`meetingSearchText({ society: "OREF", name: "New Investigator Grant", type: "grant", aim: "seed and start-up funding", criteria: "residents and fellows may apply" })`);
  check("a grant opportunity is searchable by its eligibility text", /residents and fellows/.test(mt) && /\bgrant\b/.test(mt));

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
