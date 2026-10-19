// The Publications stats page folds into the Research tab — 19 Oct 2026.
//
// Adam's own publication figures used to live on a separate full-screen page reached by a "‹ Back"
// button. The same numbers therefore existed in two places, and neither was obviously the real
// one. All nine blocks now render inside the Research tab's left column.
//
// What's worth testing is the part that could silently regress:
//
//   1. Every block actually made the move. A merge that quietly drops "Journals" or "Most cited"
//      looks fine on screen — you only notice the absence if you already knew to look.
//
//   2. The Research tab has no Back button. That was the whole complaint: it isn't a sub-page.
//
//   3. Somebody else's record is STILL a drill-down, with its Back button intact. Collapsing that
//      too would strand anyone who opened a co-author.
//
//   4. The publication figures survive watch.json being missing. The two halves of the tab come
//      from unrelated sources — an absent watch file must not take his h-index down with it.
//
//   5. The handlers wired by the shared code work on BOTH screens. wirePubStats runs against
//      whatever is currently in $main; if the Research tab forgot to call it, the co-author rows
//      and the iCite refresh button would be dead on the page people actually land on.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const USER = "test-user-1";
const now = new Date().toISOString();
const profile = () => ({
  id: USER, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: { id: USER, email: "a@example.com", name: "Adam Yanke", position: "Clinician",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true,
    tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: true },
});
// Two authors on every paper, so co-author stats have something to count and "senior author"
// can actually be non-zero.
const paper = (id, year, last) => ({
  id, kind: "study", updated_at: now, workspace: "sports-yanke",
  data: { id, title: "Paper " + id, phase: "Published", design: "Prospective (Consented)",
    priority: "Medium", pi: "Adam Yanke",
    publication: { pmid: "4" + id.slice(1).padStart(7, "0"), doi: "", year: String(year),
      title: "Cartilage paper " + id, journal: "Am J Sports Med",
      authors: last
        ? [{ fore: "Jorge", last: "Chahla", initials: "J" }, { fore: "Adam", last: "Yanke", initials: "AB" }]
        : [{ fore: "Adam", last: "Yanke", initials: "AB" }, { fore: "Jorge", last: "Chahla", initials: "J" }],
      authorList: "Yanke AB, Chahla J", importedOn: "2026-10-12" } },
});

function boot() {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({
        items: [profile(), paper("p1", 2024, false), paper("p2", 2025, true), paper("p3", 2026, true)] }) };
    },
  });
  return dom.window;
}

const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}

// The nine blocks that used to make up the standalone page.
const BLOCKS = [
  ["the four stat tiles", /co-authors/],
  ["papers per year", /Papers per year/],
  ["author position", /Where you sit on the author list/],
  ["topics", /What you publish on/],
  ["co-authors", /<div class="section-title">Co-authors<\/div>/],
  ["journals", /<div class="section-title">Journals<\/div>/],
  ["citations", /citations/],
  ["citation sources", /Citation sources/],
  ["still in progress", /Still in progress/],
];

(async () => {
  const w = boot();
  await wait(700);
  const ev = (c) => w.eval(c);

  console.log("\n-- The Research tab is the default landing view --");
  check("tab starts on research", ev("tab") === "research", ev("tab"));

  console.log("\n-- Every block moved into the Research tab --");
  // iCite figures, so the citation tiles actually draw. Without them the band correctly omits
  // those tiles, which would make the assertions below pass for the wrong reason.
  ev(`state.scholar = { id: SCHOLAR_ID,
        icite: { asOf: "2026-10-15", counts: {}, total: 6204, h: 41, i10: 142, papers: 3 },
        points: [{ date: "2026-10-15", source: "icite", h: 41, i10: 142, citations: 6204 }] };`);
  ev('tab = "research"; render();');
  const researchHTML = w.document.getElementById("main").innerHTML;
  BLOCKS.forEach(([name, re]) =>
    check("  " + name + " is on the Research tab", re.test(researchHTML)));

  console.log("\n-- ...and the watch lists are still there beside them --");
  check("the grid has both columns", /rw-side/.test(researchHTML) && /rw-main/.test(researchHTML));
  check("the publication record is in the side column",
    researchHTML.indexOf("rw-side") < researchHTML.indexOf("Papers per year"));

  console.log("\n-- The headline numbers sit across the top, above the columns --");
  // Every big figure in one row at the top. The citation counts used to be stranded at the bottom
  // under their own heading, so the page opened on the smallest number and buried the largest.
  const bandAt = researchHTML.indexOf('class="pub-band"');
  const gridAt = researchHTML.indexOf('class="rw-grid"');
  check("there is a headline band", bandAt >= 0, researchHTML.slice(0, 120));
  check("...and it comes before the two columns", bandAt >= 0 && bandAt < gridAt, bandAt + " vs " + gridAt);
  const inBand = (needle) => {
    const at = researchHTML.indexOf(needle);
    return at > 0 && at < gridAt;
  };
  ["papers", "co-authors", "journals", "senior author"].forEach(n =>
    check("  '" + n + "' is a headline tile", inBand(n)));
  check("  the h-index is a headline tile", inBand("h-index"), researchHTML.indexOf("h-index") + " vs " + gridAt);
  check("  the citation total is a headline tile", inBand("citations"));
  check("  ...carrying its source", /iCite/.test(researchHTML.slice(bandAt, gridAt)));

  console.log("\n-- Two columns the whole way down, nothing breaking out --");
  // A column that widens halfway down the page reads as a mistake. There is no full-width
  // region after the grid any more.
  check("no full-width break-out region", !/class="rw-full"/.test(researchHTML));
  ["Papers per year", "Where you sit on the author list", "What you publish on",
   '<div class="section-title">Co-authors</div>', '<div class="section-title">Journals</div>',
   "Still in progress"].forEach(n =>
    check("  '" + n.replace(/<[^>]+>/g, "") + "' is inside the grid", !inBand(n) && researchHTML.indexOf(n) > gridAt,
      researchHTML.indexOf(n) + " vs " + gridAt));

  console.log("\n-- The reading material keeps its controls, not the headline row --");
  // A form in the headline row would make the top of the page look like something to fill in.
  check("the Refresh button is below, not in the band", !inBand('id="cite-refresh"'));
  check("the Scholar entry boxes are below, not in the band", !inBand('id="sch-add"'));

  console.log("\n-- The standalone page concatenates the two parts --");
  check("pubStatsHTML hands back both parts and the whole",
    /return \{ empty: false, band, body, html: band \+ body \}/.test(html));
  check("renderPublications renders the concatenation",
    /function renderPublications\(\)[\s\S]{0,900}?stats\.html/.test(html));
  const rBody = (html.match(/function renderResearch\(\)[\s\S]*?\n}\n/) || [""])[0];
  check("renderResearch places the band and the body separately",
    /stats\.band/.test(rBody) && /stats\.body/.test(rBody), rBody.length);

  console.log("\n-- The Research tab is not a sub-page --");
  check("no Back button on the Research tab", !/id="pub-back"/.test(researchHTML),
    (researchHTML.match(/.{0,80}pub-back.{0,80}/) || [])[0]);
  check("...and no '‹ Back' label either", !researchHTML.includes("‹ Back"));

  console.log("\n-- Nothing routes to the old standalone page for your own record --");
  // The affordance that used to open it must now land on the tab.
  check("data-open-publications no longer sets showPublications",
    /data-open-publications[\s\S]{0,400}?tab = "research"/.test(html),
    (html.match(/data-open-publications[\s\S]{0,300}/) || [])[0]);
  check("showPublications is false after the tab renders", ev("showPublications") === false);

  console.log("\n-- Handlers are live on the Research tab, not just the old page --");
  const coRows = w.document.querySelectorAll("#main [data-coauthor]");
  check("co-author rows are present", coRows.length > 0, coRows.length);
  check("...and carry a click handler", coRows.length > 0 && typeof coRows[0].onclick === "function");
  const refreshBtn = w.document.getElementById("cite-refresh");
  check("the iCite refresh button is present", !!refreshBtn);
  check("...and carries a click handler", !!refreshBtn && typeof refreshBtn.onclick === "function");
  const schAdd = w.document.getElementById("sch-add");
  check("the Scholar Record button is wired", !!schAdd && typeof schAdd.onclick === "function");

  console.log("\n-- Opening a co-author is still a drill-down, with its Back button --");
  coRows[0].onclick();
  await wait(60);
  const coHTML = w.document.getElementById("main").innerHTML;
  check("clicking a co-author leaves the Research tab", ev("tab") === "studies", ev("tab"));
  check("...and names the co-author", ev("coauthorName") !== null);
  check("...and that view has a way back", /id="(pub-back|co-back)"/.test(coHTML),
    coHTML.slice(0, 200));

  console.log("\n-- Back from a drill-down returns to the Research tab, not the dashboard --");
  // Whichever back button that view rendered, it must not strand you on a page that no longer
  // exists as a destination.
  ev('coauthorName = null; showPublications = true; tab = "studies"; render();');
  await wait(60);
  const backBtn = w.document.getElementById("pub-back");
  check("the standalone page still renders for somebody else's record", !!backBtn);
  if (backBtn) {
    backBtn.onclick();
    await wait(60);
    check("...and its Back lands on the Research tab", ev("tab") === "research", ev("tab"));
    check("...with showPublications cleared", ev("showPublications") === false);
  }

  console.log("\n-- A missing watch.json does not take the publication figures down --");
  ev('watchData = null; tab = "research"; render();');
  await wait(60);
  const noWatch = w.document.getElementById("main").innerHTML;
  check("the tab still renders", noWatch.length > 500, noWatch.length);
  BLOCKS.forEach(([name, re]) =>
    check("  " + name + " survives a missing watch file", re.test(noWatch)));
  check("...and it says the watch half is empty", /No Research Watch data yet/.test(noWatch));

  console.log("\n-- An empty watch object behaves the same way --");
  ev('watchData = {}; tab = "research"; render();');
  await wait(60);
  const emptyWatch = w.document.getElementById("main").innerHTML;
  check("still renders the figures", /Papers per year/.test(emptyWatch));

  console.log("\n-- No papers at all is a normal state, not a broken page --");
  // This is what anyone signed out sees, and what a brand-new lab sees on day one. It shipped
  // once printing the literal word "undefined", because the empty branch returned only `html`
  // and the tab interpolated a `body` that didn't exist. Every key the callers read must exist.
  ev('state.studies = []; tab = "research"; render();');
  await wait(80);
  const bare = w.document.getElementById("main").innerHTML;
  check("the tab still renders", bare.length > 200, bare.length);
  check("it says there's nothing yet", /No published papers recorded yet/.test(bare));
  check("no 'undefined' anywhere on the page", !/\bundefined\b/.test(bare),
    (bare.match(/.{0,80}undefined.{0,80}/) || [])[0]);
  check("...and no 'null' or 'NaN' either", !/>\s*(null|NaN)\s*</.test(bare),
    (bare.match(/.{0,60}(null|NaN).{0,60}/) || [])[0]);
  // The same branch, via the standalone page.
  ev('showPublications = true; tab = "studies"; render();');
  await wait(80);
  const bareStandalone = w.document.getElementById("main").innerHTML;
  check("the standalone page is clean too", !/\bundefined\b/.test(bareStandalone),
    (bareStandalone.match(/.{0,80}undefined.{0,80}/) || [])[0]);
  check("...and still offers a way back", /id="pub-back"/.test(bareStandalone));
  // Every caller-read key is present on the empty return, not just the two seen above.
  const keys = ev('JSON.stringify(Object.keys(pubStatsHTML({ key: "nobody", own: true })))');
  check("the empty return carries band, body and html",
    ["band", "body", "html"].every(k => keys.includes('"' + k + '"')), keys);

  console.log("\n-- One definition, not two --");
  // The point of the refactor: both screens call the same builder. If somebody re-inlines the
  // markup later this count goes up and the two copies start to drift.
  check("pubStatsHTML is defined once", (html.match(/function pubStatsHTML\(/g) || []).length === 1);
  check("wirePubStats is defined once", (html.match(/function wirePubStats\(/g) || []).length === 1);
  check("renderResearch calls the shared builder", /function renderResearch\(\)[\s\S]{0,900}?pubStatsHTML\(/.test(html));
  check("renderPublications calls the shared builder", /function renderPublications\(\)[\s\S]{0,900}?pubStatsHTML\(/.test(html));
  // Window is generous on purpose: this asserts "somewhere inside renderResearch", and the
  // function grows. It stops at the next top-level `function ` so it can't stray into the next one.
  const researchBody = (html.match(/function renderResearch\(\)[\s\S]*?\n}\n/) || [""])[0];
  check("renderResearch wires the shared handlers", /wirePubStats\(\)/.test(researchBody),
    researchBody.length);

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
