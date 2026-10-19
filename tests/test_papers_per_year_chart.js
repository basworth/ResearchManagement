// Papers per year as a vertical bar chart — 19 Oct 2026.
//
// Replaced nineteen full-width horizontal bars, one per year, which ran off the screen so you
// could never see the shape of a career in one look. The shape is the point.
//
// Inline SVG with no library, because the app is a single file with no build step and no script
// tags — a charting dependency for nineteen rectangles would be the only external script in it.
//
// What's held here:
//   * every year in the span gets a slot, including the empty ones, so a gap reads as a gap
//   * a zero year draws a sliver and no number — an empty slot with nothing at all reads as a
//     rendering failure, and a row of 0s reads as noise
//   * the current year is visually distinct, because it is incomplete and a part-year drawn at
//     full strength looks like a decline
//   * every colour is a CSS variable, or dark mode breaks
//   * the six other charts on the page still use barRowHTML and are untouched
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const USER = "test-user-1";
const now = new Date().toISOString();
const THIS_YEAR = new Date().getFullYear();

const profile = () => ({
  id: USER, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: { id: USER, email: "a@example.com", name: "Adam Yanke", position: "Clinician",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true,
    tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: true },
});
// A span with a deliberate hole in it (THIS_YEAR-3) and a partial current year.
const YEARS = [THIS_YEAR - 5, THIS_YEAR - 4, THIS_YEAR - 2, THIS_YEAR - 1, THIS_YEAR];
const COUNTS = { [THIS_YEAR - 5]: 2, [THIS_YEAR - 4]: 5, [THIS_YEAR - 2]: 9, [THIS_YEAR - 1]: 7, [THIS_YEAR]: 3 };
const papers = [];
YEARS.forEach((y) => {
  for (let i = 0; i < COUNTS[y]; i++) {
    papers.push({
      id: "p" + y + "-" + i, kind: "study", updated_at: now, workspace: "sports-yanke",
      data: { id: "p" + y + "-" + i, title: "Paper " + y + "-" + i, phase: "Published",
        design: "Prospective (Consented)", priority: "Medium", pi: "Adam Yanke",
        publication: { pmid: String(10000000 + papers.length), doi: "", year: String(y),
          title: "Paper " + y + "-" + i, journal: "Am J Sports Med",
          authors: [{ fore: "Adam", last: "Yanke", initials: "AB" }],
          authorList: "Adam Yanke", importedOn: "2026-10-12" } },
    });
  }
});

function boot() {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items: [profile()].concat(papers) }) };
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

(async () => {
  const w = boot();
  await wait(700);
  const ev = (c) => w.eval(c);

  console.log("\n-- It draws, from the series already computed --");
  ev('tab = "studies"; showPublications = true; render();');
  await wait(300);
  const main = w.document.querySelector("#main");
  const svg = main.querySelector("svg[aria-label^='Papers per year']");
  check("there's one chart", !!svg);
  const rects = [...svg.querySelectorAll("rect")];
  // Six years inclusive of the hole: THIS_YEAR-5 … THIS_YEAR.
  check("a bar per year in the span, gaps included", rects.length === 6, rects.length);

  console.log("\n-- A year with no papers is visible as a gap --");
  const texts = [...svg.querySelectorAll("text")].map(t => t.textContent.trim());
  const yearLabels = texts.filter(t => /^\d{2}$/.test(t));
  check("two-digit year labels", yearLabels.length === 6, yearLabels);
  check("...including the empty year", yearLabels.includes(String(THIS_YEAR - 3).slice(-2)), yearLabels);
  const heights = rects.map(r => Number(r.getAttribute("height")));
  const gapBar = heights.find(h => h === 2);
  check("the empty year draws a sliver rather than nothing", gapBar === 2, heights);
  // A "0" above the gap would be noise; nothing at all would read as a bug. Sliver, no number.
  check("...and carries no count label", !texts.includes("0"), texts);

  console.log("\n-- Counts sit above the bars --");
  Object.values(COUNTS).forEach(n => {
    check("  the count " + n + " is shown", texts.includes(String(n)), texts);
  });
  const tallest = Math.max(...heights);
  check("the biggest year is the tallest bar", tallest === Math.max(...heights), tallest);
  check("...and the chart stays compact", Number(svg.getAttribute("height")) <= 150,
    svg.getAttribute("height"));

  console.log("\n-- The current year is marked as incomplete --");
  const fills = rects.map(r => r.getAttribute("fill"));
  const tinted = fills.filter(f => /color-mix/.test(f));
  check("exactly one bar is tinted", tinted.length === 1, fills);
  check("...and it's the last one, the current year",
    /color-mix/.test(fills[fills.length - 1]), fills);
  check("...with a caption explaining why",
    /lighter bar is this year/i.test(main.textContent));

  console.log("\n-- Every colour is a variable, or dark mode breaks --");
  const svgHTML = svg.outerHTML;
  check("no hex literals", !/#[0-9a-f]{3,8}\b/i.test(svgHTML), (svgHTML.match(/#[0-9a-f]{3,8}/i) || [])[0]);
  check("no rgb() literals", !/rgba?\(/i.test(svgHTML));
  check("bars use --blue", /var\(--blue\)/.test(svgHTML));
  check("text uses the text variables", /var\(--text\)/.test(svgHTML) && /var\(--text2\)/.test(svgHTML));
  check("the baseline uses --line", /var\(--line\)/.test(svgHTML));

  console.log("\n-- No new dependencies --");
  check("still no external scripts in the file",
    !/<script[^>]+src=/i.test(html), (html.match(/<script[^>]+src=[^>]*>/i) || [])[0]);
  check("no charting library named anywhere",
    !/chart\.js|d3\.|recharts|plotly|highcharts|apexcharts/i.test(html));

  console.log("\n-- Readable by something that isn't looking --");
  check("the chart has an accessible label", /Papers per year/.test(svg.getAttribute("aria-label")));
  check("...naming the span and the total", /\d{4}–\d{4}/.test(svg.getAttribute("aria-label"))
    && /26 in total/.test(svg.getAttribute("aria-label")), svg.getAttribute("aria-label"));

  console.log("\n-- The other six charts on this page are untouched --");
  check("barRowHTML still exists", ev("typeof barRowHTML") === "function");
  check("...and is still used for the author-position chart",
    /Where you sit on the author list/.test(main.textContent));
  check("...and the topics chart", /What you publish on/.test(main.textContent));
  check("the page still has progress bars from it",
    main.querySelectorAll(".progressbar").length > 0,
    main.querySelectorAll(".progressbar").length);

  console.log("\n-- Degenerate inputs don't throw --");
  check("a single year renders", /svg/.test(ev('pubYearChartHTML([[2026, 1]], 1)')));
  check("an empty series returns nothing rather than a broken chart",
    ev('pubYearChartHTML([], 0)') === "");
  check("a max of zero doesn't divide by zero",
    !/NaN/.test(ev('pubYearChartHTML([[2026, 0]], 0)')), ev('pubYearChartHTML([[2026, 0]], 0)'));

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
