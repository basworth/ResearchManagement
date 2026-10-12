// A published paper on a study: its citation, its full author list, and — the point of the whole
// feature — being able to find a paper by someone you wrote it with.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const ME = "11111111-1111-1111-1111-111111111111";
const PUB = "aaaaaaaa-0000-0000-0000-0000000000p1";
const PLAIN = "aaaaaaaa-0000-0000-0000-0000000000p2";
const now = new Date().toISOString();
const publication = {
  pmid: "42490302", doi: "10.1002/arj.70422",
  title: "Isolated Medial Patellofemoral Ligament Reconstruction Reduces Patellar Height",
  journal: "Arthroscopy", year: "2026",
  authors: [
    { last: "Sachdev", fore: "Divesh", initials: "D" },
    { last: "Smelley", fore: "Cade", initials: "C" },
    { last: "Lemme", fore: "Nicholas", initials: "N" },
    { last: "Yanke", fore: "Adam B", initials: "AB" }
  ],
  authorList: "Divesh Sachdev, Cade Smelley, Nicholas Lemme, Adam B Yanke"
};
const study = (id, title, extra) => ({ id, kind: "study", updated_at: now, workspace: "sports-yanke",
  data: Object.assign({ id, title, nickname: "", phase: "Published", design: "Retrospective (Non-Consented)",
    pi: "Adam Yanke", team: [], milestones: [], meetingNotes: [], authors: [], abstracts: [], docs: [] }, extra) });
const items = [
  { id: ME, kind: "profile", updated_at: now, workspace: "sports-yanke",
    data: { id: ME, name: "Adam Yanke", email: "a@b.c", position: "Clinician", admin: true,
            reportsTo: "", alertEmail: "", linkedTo: "", alertEmailAsked: true, degreesAsked: true } },
  study(PUB, "MPFL reconstruction and patellar height", { publication }),
  study(PLAIN, "A study with no paper yet", { phase: "Analysis" }),
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now, workspace: "sports-yanke",
    data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} } }
];

const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items, userId: ME, email: "a@b.c" }) };
  }
});
const { window } = dom, doc = window.document;
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);
const open = id => window.eval(`detailStudyId = ${JSON.stringify(id)}; tab = "studies"; render();`);

(async () => {
  await wait(400);
  window.eval("syncOnline = true;");
  open(PUB); await wait(80);
  const main = () => doc.getElementById("main");

  console.log("\n-- The paper is shown on the study --");
  check("a Publication section exists", !!doc.querySelector('[data-sec-toggle="publication"]'));
  check("...and it opens by default on a Published study",
    window.eval(`!!studySectionState["publication"]`));
  check("the journal and year are in the collapsed header", main().textContent.includes("Arthroscopy · 2026"));

  console.log("\n-- Every co-author is listed --");
  const body = doc.querySelector('[data-sec-body="publication"]').textContent;
  check("a co-author appears", body.includes("Divesh Sachdev"), body.slice(0, 160));
  check("...and so does the last one", body.includes("Adam B Yanke"));
  check("the count is shown", /Authors \(4\)/.test(body), body.slice(0, 200));

  console.log("\n-- Links out --");
  const links = [...doc.querySelector('[data-sec-body="publication"]').querySelectorAll("a")].map(a => a.href);
  check("PubMed link points at the right record", links.some(h => h.includes("pubmed.ncbi.nlm.nih.gov/42490302")), links);
  check("DOI link resolves through doi.org", links.some(h => h.includes("doi.org/10.1002/arj.70422")), links);

  console.log("\n-- Finding a paper by who you wrote it with --");
  check("searching a co-author's name finds the study",
    window.eval(`studyMatchesSearch(studyById(${JSON.stringify(PUB)}), "sachdev")`) === true);
  check("...by surname alone too",
    window.eval(`studyMatchesSearch(studyById(${JSON.stringify(PUB)}), "Lemme")`) === true);
  check("...by journal", window.eval(`studyMatchesSearch(studyById(${JSON.stringify(PUB)}), "arthroscopy")`) === true);
  check("...by PMID", window.eval(`studyMatchesSearch(studyById(${JSON.stringify(PUB)}), "42490302")`) === true);
  check("a study without that co-author is not matched",
    window.eval(`studyMatchesSearch(studyById(${JSON.stringify(PLAIN)}), "sachdev")`) === false);

  console.log("\n-- A study with no paper is unaffected --");
  open(PLAIN); await wait(80);
  check("no Publication section appears", !doc.querySelector('[data-sec-toggle="publication"]'));
  check("the rest of the study page still renders", main().textContent.includes("A study with no paper yet"));

  console.log("\n-- The imported list is kept separate from the planned one --");
  check("Proposed Authors is untouched by the import",
    window.eval(`JSON.stringify(studyById(${JSON.stringify(PUB)}).authors)`) === "[]");

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
