// Whose publications the page shows. A PI sees their own; anyone else sees the PI they report to.
// Before this the page was built around a hardcoded "Yanke", so a second PI would have seen his
// name bolded on what was supposed to be their record.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const YANKE = "11111111-1111-1111-1111-111111111111";
const SINGH = "22222222-2222-2222-2222-222222222222";
const COORD = "33333333-3333-3333-3333-333333333333";   // reports to Singh
const ORPHAN = "44444444-4444-4444-4444-444444444444";  // reports to nobody, has no papers
const now = new Date().toISOString();
const A = (fore, last) => ({ fore, last, initials: fore[0] });
const prof = (id, name, reportsTo, admin) => ({ id, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: { id, name, email: name.replace(/\s/g, "") + "@x.c", position: "Clinician", admin: !!admin,
          reportsTo: reportsTo || "", alertEmail: "", linkedTo: "", alertEmailAsked: true, degreesAsked: true } });
const paper = (id, title, year, authors) => ({ id, kind: "study", updated_at: now, workspace: "sports-yanke",
  data: { id, title, nickname: "", phase: "Published", design: "Retrospective (Non-Consented)",
    pi: "Adam Yanke", team: [], milestones: [], meetingNotes: [], authors: [], abstracts: [], docs: [],
    publication: { pmid: id, doi: "10.0/" + id, title, journal: "Arthroscopy", year, authors,
      authorList: authors.map(a => a.fore + " " + a.last).join(", ") } } });

const items = [
  prof(YANKE, "Adam Yanke", "", true),
  prof(SINGH, "Kern Singh", "", true),
  prof(COORD, "Jane Coordinator", SINGH, false),
  prof(ORPHAN, "Nobody Atall", "", false),
  // Two of Yanke's, two of Singh's, one they share.
  paper("y1", "Cartilage restoration of the patella", "2024", [A("Divesh", "Sachdev"), A("Adam B", "Yanke")]),
  paper("y2", "Meniscus transplantation outcomes", "2023", [A("Adam B", "Yanke"), A("Cade", "Smelley")]),
  paper("k1", "Cervical disc arthroplasty outcomes", "2025", [A("Kern", "Singh"), A("Spine", "Fellow")]),
  paper("k2", "Lumbar fusion in the ambulatory setting", "2024", [A("Spine", "Fellow"), A("Kern", "Singh")]),
  paper("both", "Combined spine and knee registry methods", "2026", [A("Kern", "Singh"), A("Adam B", "Yanke")]),
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now, workspace: "sports-yanke",
    data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke", "Kern Singh", "Jane Coordinator"], degrees: {} } }
];

function boot(asUser, email) {
  return new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items, userId: asUser, email }) };
    }
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);

async function open(dom) {
  const w = dom.window;
  await wait(400);
  w.eval("syncOnline = true; showPublications = true; tab = 'studies'; render();");
  await wait(150);
  return { w, text: () => w.document.getElementById("main").textContent.replace(/\s+/g, " "),
           co: () => [...w.document.querySelectorAll("[data-coauthor]")].map(e => e.textContent.replace(/\s+/g, " ").trim()) };
}

(async () => {
  console.log("\n-- A PI sees their own record --");
  {
    const { w, text, co } = await open(boot(YANKE, "AdamYanke@x.c"));
    check("the subject is himself", w.eval("publicationsSubject().own") === true);
    check("three papers — his two plus the shared one", /3 papers/.test(text()), text().slice(0, 120));
    check("the spine-only papers are not his", !/Cervical disc/.test(text()) && !/Lumbar fusion/.test(text()));
    check("his co-authors include Singh from the shared paper", co().some(n => /Singh/.test(n)), co());
    check("...and he is not listed as his own co-author", !co().some(n => /Yanke/.test(n)), co());
    check("no banner, because it's his own page", !/Showing/.test(text()));
    w.close();
  }

  console.log("\n-- A second PI sees a different record entirely --");
  {
    const { w, text, co } = await open(boot(SINGH, "KernSingh@x.c"));
    check("the subject is Singh", w.eval("publicationsSubject().name") === "Kern Singh", w.eval("publicationsSubject().name"));
    check("three papers — his two plus the shared one", /3 papers/.test(text()), text().slice(0, 120));
    check("Yanke's own papers are absent", !/Meniscus transplantation/.test(text()));
    check("his own name isn't in his co-author list", !co().some(n => /Singh/.test(n)), co());
    check("Yanke appears as a co-author on the shared paper", co().some(n => /Yanke/.test(n)), co());
    w.close();
  }

  console.log("\n-- Someone who reports to a PI sees that PI's page --");
  {
    const { w, text } = await open(boot(COORD, "JaneCoordinator@x.c"));
    check("the subject is her PI", w.eval("publicationsSubject().name") === "Kern Singh", w.eval("publicationsSubject().name"));
    check("it says whose page this is", /Showing Kern Singh's publications/.test(text()), text().slice(0, 200));
    check("...and why", /you report to Kern Singh/.test(text()));
    check("she sees his three papers", /3 papers/.test(text()));
    w.close();
  }

  console.log("\n-- Nobody to inherit from --");
  {
    const { w, text } = await open(boot(ORPHAN, "NobodyAtall@x.c"));
    check("falls back to the lab's main author rather than an empty page",
      w.eval("publicationsSubject().own") === false && /papers/.test(text()), text().slice(0, 160));
    check("...and says that's what it did", /main author/.test(text()), text().slice(0, 200));
    w.close();
  }

  console.log("\n-- Author position is computed for the subject, not for Yanke --");
  {
    const { w, text } = await open(boot(SINGH, "KernSingh@x.c"));
    // Singh is first on k1 and 'both', last on k2.
    const t = text();
    check("his first-author count is his own", /First author 2/.test(t), t.slice(t.indexOf("Where you sit"), t.indexOf("Where you sit") + 140));
    check("his senior-author count is his own", /Senior \(last\) author 1/.test(t), t.slice(t.indexOf("Where you sit"), t.indexOf("Where you sit") + 140));
    w.close();
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
