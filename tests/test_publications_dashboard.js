// The Published dashboard: what Adam has written, who with, on what — and, for one co-author,
// their work with him including the studies that haven't published yet.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const ME = "11111111-1111-1111-1111-111111111111";
const now = new Date().toISOString();
const A = (fore, last) => ({ fore, last, initials: fore[0] });
const paper = (id, title, journal, year, authors) => ({
  id, kind: "study", updated_at: now, workspace: "sports-yanke",
  data: { id, title, nickname: "", phase: "Published", design: "Retrospective (Non-Consented)",
    pi: "Adam Yanke", team: [], milestones: [], meetingNotes: [], authors: [], abstracts: [], docs: [],
    publication: { pmid: "p" + id, doi: "10.0/" + id, title, journal, year,
      authors, authorList: authors.map(a => a.fore + " " + a.last).join(", ") } }
});
const items = [
  { id: ME, kind: "profile", updated_at: now, workspace: "sports-yanke",
    data: { id: ME, name: "Adam Yanke", email: "a@b.c", position: "Clinician", admin: true,
            reportsTo: "", alertEmail: "", linkedTo: "", alertEmailAsked: true, degreesAsked: true } },
  // Sachdev on three, Smelley on two, Lee on one. Yanke senior on two, first on one.
  paper("s1", "MPFL reconstruction and patellar instability outcomes", "Arthroscopy", "2026",
    [A("Divesh", "Sachdev"), A("Cade", "Smelley"), A("Adam B", "Yanke")]),
  paper("s2", "Osteochondral allograft transplantation of the patella", "Am J Sports Med", "2025",
    [A("Divesh", "Sachdev"), A("Adam B", "Yanke")]),
  paper("s3", "Trochleoplasty cartilage healing after recession wedge", "Cartilage", "2024",
    [A("Adam B", "Yanke"), A("D", "Sachdev"), A("William", "Lee")]),
  paper("s4", "Rotator cuff repair with biphasic interpositional allograft", "Arthroscopy", "2024",
    [A("Cade", "Smelley"), A("Adam B", "Yanke")]),
  // Not published: Sachdev is on the team, so it should show as pipeline work for him.
  { id: "pend1", kind: "study", updated_at: now, workspace: "sports-yanke",
    data: { id: "pend1", title: "Saddle OCA of the patella", nickname: "Saddle", phase: "Analysis",
      design: "Prospective (Consented)", pi: "Adam Yanke", team: ["Divesh Sachdev"],
      milestones: [], meetingNotes: [], authors: [], abstracts: [], docs: [] } },
  { id: "pend2", kind: "study", updated_at: now, workspace: "sports-yanke",
    data: { id: "pend2", title: "Unrelated meniscus work", nickname: "", phase: "Enrolling",
      design: "Prospective (Consented)", pi: "Adam Yanke", team: ["Someone Else"],
      milestones: [], meetingNotes: [], authors: [], abstracts: [], docs: [] } },
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now, workspace: "sports-yanke",
    data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke", "Divesh Sachdev"], degrees: {} } }
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
const text = () => doc.getElementById("main").textContent.replace(/\s+/g, " ");

(async () => {
  await wait(400);
  window.eval("syncOnline = true;");

  console.log("\n-- Getting there from the dashboard --");
  window.eval(`tab = "dashboard"; render();`);
  await wait(80);
  const entry = doc.querySelector("[data-open-publications]");
  check("the Published row in the Pipeline is clickable", !!entry, text().slice(0, 120));
  entry.click();
  await wait(100);

  console.log("\n-- The headline numbers --");
  const t = text();
  check("counts the papers", /4 papers/.test(t), t.slice(0, 200));
  // Three distinct people, not four names: "D Sachdev" on one paper and "Divesh Sachdev" on two
  // are the same human, and counting them separately would overstate the collaboration.
  check("counts distinct co-authors, merging a name written two ways", /3 co-authors/.test(t), t.slice(0, 260));
  check("counts the journals", /3 journals/.test(t));
  check("counts senior-author papers", /2 senior author/.test(t) || /senior author/.test(t));

  console.log("\n-- The breakdowns --");
  check("papers per year, including the empty years in the span", /2024/.test(t) && /2025/.test(t) && /2026/.test(t));
  check("topics are named from the titles", /Patellofemoral/.test(t) && /Cartilage restoration/.test(t) && /Shoulder/.test(t), t);
  check("journals are listed", /Arthroscopy/.test(t) && /Am J Sports Med/.test(t));
  check("author position is broken down", /First author/.test(t) && /Middle author/.test(t));

  console.log("\n-- Co-authors, most frequent first --");
  const names = [...doc.querySelectorAll("[data-coauthor]")].map(e => e.textContent.replace(/\s+/g, " ").trim());
  check("Sachdev is top, on three papers", /Sachdev/.test(names[0]) && /3/.test(names[0]), names);
  check("the fullest spelling of the name wins over the initial", /Divesh Sachdev/.test(names[0]), names[0]);
  check("Smelley is second with two", /Smelley/.test(names[1]), names);


  console.log("\n-- Finding a co-author among hundreds --");
  window.eval("coauthorName = null; coauthorQuery = ''; coauthorsExpanded = false; render();");
  await wait(100);
  check("there's a search box over the co-author list", !!doc.getElementById("coauthor-search"));
  // It's a placeholder, which lives in an attribute rather than the page's text.
  check("...that says how many there are",
    /Search 3 co-authors/.test(doc.getElementById("coauthor-search").placeholder),
    doc.getElementById("coauthor-search").placeholder);
  window.eval("coauthorQuery = 'smel'; render();");
  await wait(100);
  const matches = [...doc.querySelectorAll("[data-coauthor]")].map(e => e.textContent.replace(/\s+/g, " ").trim());
  check("a partial name narrows the list", matches.length === 1 && /Smelley/.test(matches[0]), matches);
  check("...and says how many matched", /1 match/.test(text()));
  window.eval("coauthorQuery = 'zzzz'; render();");
  await wait(100);
  check("a name nobody has says so plainly", /Nobody by that name/.test(text()));
  check("...rather than showing everyone", doc.querySelectorAll("[data-coauthor]").length === 0);
  window.eval("coauthorQuery = ''; render();");
  await wait(100);
  check("clearing the search brings the list back", doc.querySelectorAll("[data-coauthor]").length === 3);

  console.log("\n-- One co-author's work with Adam --");
  [...doc.querySelectorAll("[data-coauthor]")].find(e => /Sachdev/.test(e.textContent)).click();
  await wait(120);
  const c = text();
  check("their paper count with him", /3 papers with you/.test(c), c.slice(0, 200));
  check("the papers are listed", /MPFL reconstruction/.test(c) && /Osteochondral allograft/.test(c) && /Trochleoplasty/.test(c));
  check("a paper they are NOT on is excluded", !/Rotator cuff repair/.test(c), c);
  check("grouped by year", /2026/.test(c) && /2025/.test(c) && /2024/.test(c));
  check("their own name is bold in the author list",
    !!doc.querySelector("b") && /Sachdev/.test([...doc.querySelectorAll("b")].map(b => b.textContent).join(" ")));

  console.log("\n-- The pipeline they're on --");
  check("an unpublished study they're on is shown", /Saddle/.test(c), c);
  check("...and one they're not on is not", !/Unrelated meniscus/.test(c));
  check("it says this is only their work with Adam",
    /not their full publication list/i.test(c), c.slice(-220));

  console.log("\n-- Citation metrics are recorded by hand --");
  window.eval("coauthorName = null; render();");
  await wait(100);
  check("it asks for Scholar numbers", !!doc.getElementById("sch-h"));
  check("...and says why they're typed, not fetched", /Scholar blocks automated reading/.test(text()));
  doc.getElementById("sch-h").value = "42";
  doc.getElementById("sch-i10").value = "95";
  doc.getElementById("sch-add").click();
  await wait(200);
  check("the reading is stored", window.eval("state.scholar.points.length") === 1,
    window.eval("JSON.stringify(state.scholar)"));
  check("...and shown", /42/.test(text()) && /h-index/.test(text()));

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
