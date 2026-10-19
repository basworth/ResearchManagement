// Renders the Research tab to standalone HTML files so it can actually be looked at, at a chosen
// width and colour scheme. Not a test — a way to see the thing. The dark-mode link bug that
// shipped in an earlier round was invisible in the markup and obvious on screen.
//
//   node tests/make_research_mock.js <outdir>
//
// Two things make this fiddlier than dumping innerHTML into a file:
//
//   1. Media queries key off the VIEWPORT, not off the element. A 1200px-wide <div> inside a
//      577px preview panel still gets the phone layout, so a mock built that way would show a
//      single column and prove nothing. Each frame therefore goes in its own <iframe>, which does
//      get its own viewport, then is scaled down with a transform to fit the panel.
//
//   2. The app has no theme switch — it reads prefers-color-scheme. The panel decides that, so to
//      see both schemes the dark block is either stripped (light) or forced on (dark).
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const watch = JSON.parse(fs.readFileSync(path.join(PROJECT, "watch.json"), "utf8"));

const OUTDIR = process.argv[2] || "/tmp";
const USER = "u1";
const now = new Date().toISOString();

const CO = [["Jorge", "Chahla"], ["Brian", "Cole"], ["Nikhil", "Verma"], ["Brian", "Forsythe"],
            ["Yining", "Lu"], ["Navya", "Dandu"], ["Tristan", "Elias"], ["Hannah", "Lundberg"],
            ["Erik", "Hanneberg"], ["Andrew", "Phillips"]];
const JOURNALS = ["Am J Sports Med", "Arthroscopy", "Orthop J Sports Med", "Cartilage", "JBJS",
                  "Knee Surg Sports Traumatol Arthrosc", "Am J Orthop"];
const TITLES = ["cartilage restoration", "ACL reconstruction", "patellofemoral instability",
                "meniscal allograft transplantation", "osteochondral allograft survivorship"];

const profile = {
  id: USER, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: { id: USER, email: "a@example.com", name: "Adam Yanke", position: "Clinician",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true,
    tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: true },
};

// A spread of years, author positions and co-authors, so every block has something real to draw.
const studies = [];
let n = 0;
for (let year = 2008; year <= 2026; year++) {
  const count = year < 2013 ? 3 : year < 2019 ? 9 : 26;
  for (let i = 0; i < count; i++) {
    n++;
    const senior = i % 3 === 0, first = i % 3 === 1;
    const c = CO[n % CO.length];
    const other = { fore: c[0], last: c[1], initials: c[0][0] };
    const c2 = CO[(n + 3) % CO.length];
    const third = { fore: c2[0], last: c2[1], initials: c2[0][0] };
    const him = { fore: "Adam", last: "Yanke", initials: "AB" };
    const authors = senior ? [other, third, him] : first ? [him, other, third] : [other, him, third];
    studies.push({
      id: "s" + n, kind: "study", updated_at: now, workspace: "sports-yanke",
      data: {
        id: "s" + n, title: "Study " + n, phase: "Published",
        design: "Prospective (Consented)", priority: "Medium", pi: "Adam Yanke",
        publication: {
          pmid: String(40000000 + n), doi: "10.1177/" + n, year: String(year),
          title: "Outcomes of " + TITLES[n % TITLES.length] + " at minimum " + (2 + (n % 8)) + "-year follow-up",
          journal: JOURNALS[n % JOURNALS.length],
          authors, authorList: "Yanke AB et al", importedOn: "2026-10-12",
        },
      },
    });
  }
}
for (let i = 0; i < 12; i++) {
  studies.push({ id: "u" + i, kind: "study", updated_at: now, workspace: "sports-yanke",
    data: { id: "u" + i, title: "Unpublished " + i, phase: "Enrolling",
      design: "Retrospective", priority: "Medium", pi: "Adam Yanke" } });
}

// Pull out the @media (prefers-color-scheme: dark) block by counting braces — a regex can't match
// nested rules, and getting it wrong would silently drop half the stylesheet.
function darkBlock(css) {
  const at = css.indexOf("@media (prefers-color-scheme: dark)");
  if (at < 0) return { start: -1, end: -1 };
  let i = css.indexOf("{", at), depth = 0;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (!depth) return { start: at, end: i + 1 }; }
  }
  return { start: -1, end: -1 };
}

const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items: [profile, ...studies] }) };
  },
});
const w = dom.window;

setTimeout(() => {
  w.eval(`
    state.scholar = { id: SCHOLAR_ID,
      icite: { asOf: "2026-10-15", counts: {}, total: 6204, h: 41, i10: 142, papers: 276 },
      points: [{date:"2026-06-01",source:"icite",h:38,i10:130,citations:5600},
               {date:"2026-10-15",source:"icite",h:41,i10:142,citations:6204},
               {date:"2026-03-01",source:"scholar",h:49,i10:171,citations:8400},
               {date:"2026-10-15",source:"scholar",h:52,i10:180,citations:9100}] };
    watchData = ${JSON.stringify(watch)};
    tab = "research"; render();
  `);

  const body = w.document.getElementById("main").innerHTML;
  const rawCSS = [...w.document.querySelectorAll("style")].map(s => s.textContent).join("\n");
  const { start, end } = darkBlock(rawCSS);
  if (start < 0) { console.error("could not find the dark-mode block"); process.exit(1); }
  const lightCSS = rawCSS.slice(0, start) + rawCSS.slice(end);
  const darkCSS = rawCSS.slice(0, start) + "@media all" + rawCSS.slice(start + "@media (prefers-color-scheme: dark)".length);

  const page = (css) => `<!doctype html><meta charset="utf-8">
<style>${css}
  html,body{margin:0;background:var(--bg)}
  #main{padding:16px}
</style><div id="main">${body}</div>`;

  // The iframe gets its own viewport, so the media queries behave. Then it's scaled to fit the
  // ~577px preview panel without changing what the layout thinks its width is.
  const PANEL = 560;
  const file = (name, width, height, css, label) => {
    const scale = Math.min(1, PANEL / width);
    const doc = page(css).replace(/"/g, "&quot;");
    fs.writeFileSync(path.join(OUTDIR, name), `<!doctype html><meta charset="utf-8">
<title>${label}</title>
<style>
  body{margin:0;background:#eee;font:700 11px/1 -apple-system,system-ui,sans-serif;
       letter-spacing:.08em;text-transform:uppercase;color:#777}
  .lab{padding:8px 10px}
  .wrap{width:${Math.round(width * scale)}px;height:${Math.round(height * scale)}px;overflow:hidden}
  iframe{width:${width}px;height:${height}px;border:0;transform:scale(${scale});transform-origin:0 0}
</style>
<div class="lab">${label} — rendered at ${width}px</div>
<div class="wrap"><iframe srcdoc="${doc}"></iframe></div>`);
    console.log("wrote " + name + " (" + width + "px, scale " + scale.toFixed(2) + ")");
  };

  file("research-desktop-light.html", 1280, 2000, lightCSS, "Desktop · light");
  file("research-desktop-dark.html", 1280, 2000, darkCSS, "Desktop · dark");
  file("research-phone-light.html", 390, 1500, lightCSS, "Phone 390px · light");
  file("research-phone-dark.html", 390, 1500, darkCSS, "Phone 390px · dark");
  process.exit(0);
}, 1200);
