// Citations from NIH's iCite: the h-index computed from Adam's own papers, kept apart from the
// hand-entered Google Scholar numbers because the two count different literature.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const ME = "11111111-1111-1111-1111-111111111111";
const now = new Date().toISOString();
const A = (fore, last) => ({ fore, last, initials: fore[0] });
// Counts chosen to pin the off-by-one that h-index invites: 30, 12, 9, 3, 1 gives h = 3.
// Four papers have at least 3 citations, which tempts you towards 4 — but h = 4 would need four
// papers with at least FOUR citations, and the fourth has exactly 3.
const CITES = { p1: 30, p2: 12, p3: 9, p4: 3, p5: 1 };
const paper = (id, title, year) => ({
  id, kind: "study", updated_at: now, workspace: "sports-yanke",
  data: { id, title, nickname: "", phase: "Published", design: "Retrospective (Non-Consented)",
    pi: "Adam Yanke", team: [], milestones: [], meetingNotes: [], authors: [], abstracts: [], docs: [],
    publication: { pmid: id, doi: "10.0/" + id, title, journal: "Arthroscopy", year,
      authors: [A("Divesh", "Sachdev"), A("Adam B", "Yanke")], authorList: "Divesh Sachdev, Adam B Yanke" } }
});
const items = [
  { id: ME, kind: "profile", updated_at: now, workspace: "sports-yanke",
    data: { id: ME, name: "Adam Yanke", email: "a@b.c", position: "Clinician", admin: true,
            reportsTo: "", alertEmail: "", linkedTo: "", alertEmailAsked: true, degreesAsked: true } },
  paper("p1", "Most cited paper about cartilage", "2018"),
  paper("p2", "Second paper about meniscus", "2020"),
  paper("p3", "Third paper about the patella", "2021"),
  paper("p4", "Fourth paper about the shoulder", "2023"),
  paper("p5", "Newest paper about the ACL", "2026"),
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now, workspace: "sports-yanke",
    data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} } }
];

let iciteCalls = 0;
const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items, userId: ME, email: "a@b.c" }) };
    // Stand in for iCite so the test needs no network and the numbers are known.
    const realFetch = win.fetch;
    win.fetch = async (url, opts) => {
      if (String(url).includes("icite.od.nih.gov")) {
        iciteCalls++;
        const ids = String(url).split("pmids=")[1].split(",");
        return { ok: true, status: 200, json: async () => ({
          data: ids.map(id => ({ pmid: id, citation_count: CITES[id] ?? 0 })) }) };
      }
      return realFetch ? realFetch(url, opts) : { ok: false, status: 599, json: async () => ({}) };
    };
  }
});
const { window } = dom, doc = window.document;
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);
const text = () => doc.getElementById("main").textContent.replace(/\s+/g, " ");

(async () => {
  await wait(400);
  window.eval("syncOnline = true; showPublications = true; tab = 'studies'; render();");
  await wait(120);

  console.log("\n-- The h-index maths --");
  check("h of [30,12,9,3,1] is 3, not 4", window.eval("hIndexFrom([30,12,9,3,1])") === 3, window.eval("hIndexFrom([30,12,9,3,1])"));
  check("h of an uncited body of work is 0", window.eval("hIndexFrom([0,0,0])") === 0);
  check("h can't exceed the number of papers", window.eval("hIndexFrom([99,99])") === 2);
  check("h of a single paper cited once is 1", window.eval("hIndexFrom([1])") === 1);

  console.log("\n-- Before any fetch --");
  check("it offers to fetch rather than showing nothing", !!doc.getElementById("cite-refresh"));
  check("...and explains what iCite is", /iCite publishes citation counts/.test(text()), text().slice(0, 300));

  console.log("\n-- Fetching --");
  doc.getElementById("cite-refresh").click();
  await wait(500);
  check("iCite was called", iciteCalls > 0, iciteCalls);
  const ic = JSON.parse(window.eval("JSON.stringify(state.scholar.icite)"));
  check("h-index computed from the real counts", ic.h === 3, ic);
  check("i10 counts papers with ten or more", ic.i10 === 2, ic.i10);
  check("total citations summed", ic.total === 55, ic.total);
  check("...across every paper", ic.papers === 5, ic.papers);
  check("stored in one row, not on each study",
    window.eval("state.studies.filter(s => s.publication && s.publication.citations != null).length") === 0);

  console.log("\n-- Shown on the page --");
  const t = text();
  check("the h-index appears", /h-index/.test(t) && /3/.test(t));
  check("labelled as iCite", /NIH iCite/.test(t), t.slice(0, 400));
  check("most cited papers are listed, highest first",
    t.indexOf("Most cited paper about cartilage") < t.indexOf("Second paper about meniscus"), t.slice(t.indexOf("Most cited"), t.indexOf("Most cited") + 200));
  check("an uncited paper is left out of Most cited",
    !t.slice(t.indexOf("Most cited"), t.indexOf("Google Scholar")).includes("Newest paper about the ACL"));

  console.log("\n-- A reading is recorded for the chart --");
  const pts = JSON.parse(window.eval("JSON.stringify(state.scholar.points)"));
  check("one point, tagged as iCite", pts.length === 1 && pts[0].source === "icite", pts);
  doc.getElementById("cite-refresh").click();
  await wait(500);
  check("refreshing the same day doesn't stack up duplicates",
    JSON.parse(window.eval("JSON.stringify(state.scholar.points)")).length === 1);

  console.log("\n-- Scholar's numbers stay separate --");
  doc.getElementById("sch-h").value = "61";
  doc.getElementById("sch-add").click();
  await wait(300);
  const all = JSON.parse(window.eval("JSON.stringify(state.scholar.points)"));
  check("both readings are kept", all.length === 2, all);
  check("...distinguishable by source", all.filter(p => p.source === "icite").length === 1 && all.filter(p => p.source === "scholar").length === 1, all);
  check("the typed number did not overwrite the computed one",
    JSON.parse(window.eval("JSON.stringify(state.scholar.icite)")).h === 3);
  check("the page says they count different things",
    /count different things/.test(text()));

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
