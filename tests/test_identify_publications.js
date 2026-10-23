// Confirm your publications: the server half — 23 Oct 2026.
//
// Adam, 22 Oct: "Park was at Michigan, so stuff he did in the past is still going to be relevant."
// research-watch's `identify` action looks a name up in PubMed with NO affiliation filter and
// groups what comes back by the institution on that person's own byline, so they can tick
// "University of Michigan" and "Rush" as wholes and untick the strangers.
//
// The parsing is where this goes wrong quietly. A paper credited to the wrong author on the byline,
// or an affiliation boiled down to "Department of Orthopaedic Surgery" (which every hospital has),
// would put strangers in the same group as the person, and they would tick them in good faith.
// PubMed is unreachable from the test sandbox, so this runs the real parsing code from the
// function against a fixture shaped exactly like efetch's XML.
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "supabase", "functions", "research-watch", "index.ts"), "utf8");
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}

const start = SRC.indexOf("// ---------- identify:");
const end = SRC.indexOf("async function identify(");
if (start < 0 || end < 0) { console.log("  FAIL identify helpers not found in research-watch"); process.exit(1); }
const helpers = SRC.slice(start, end).replace(/\bexport\s+/g, "");
// Types are stripped rather than compiled: Node 22 can do it natively, and the TypeScript package
// the runner installs (7.x) no longer has a JavaScript API to call. tsc is the fallback.
function toJs(src) {
  const mod = require("module");
  if (typeof mod.stripTypeScriptTypes === "function") return mod.stripTypeScriptTypes(src);
  const os = require("os"), { execFileSync } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "identify-"));
  fs.writeFileSync(path.join(dir, "h.ts"), src);
  const tsc = path.join(path.dirname(require.resolve("typescript/package.json")), "bin", "tsc");
  try { execFileSync(process.execPath, [tsc, "--target", "es2020", "--outDir", dir, path.join(dir, "h.ts")], { stdio: "ignore" }); } catch (_) {}
  return fs.readFileSync(path.join(dir, "h.js"), "utf8");
}
const js = toJs(helpers);
const lib = new Function("NCBI_KEY", "NCBI_EMAIL", "getJSON", "clean", "phrase",
  js + "\nreturn { orgFromAffiliation, parseArticlesFor, clusterByOrg, xmlText };")(
  "", "", async () => ({}), (a) => (Array.isArray(a) ? a : []), (s) => s);

const author = (last, initials, fore, aff) => `<Author ValidYN="Y"><LastName>${last}</LastName><ForeName>${fore}</ForeName><Initials>${initials}</Initials>${aff ? `<AffiliationInfo><Affiliation>${aff}</Affiliation></AffiliationInfo>` : ""}</Author>`;
const article = (pmid, year, title, authors) => `<PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">${pmid}</PMID><Article PubModel="Print"><Journal><JournalIssue CitedMedium="Internet"><PubDate><Year>${year}</Year><Month>Mar</Month></PubDate></JournalIssue><Title>The American journal of sports medicine</Title><ISOAbbreviation>Am J Sports Med</ISOAbbreviation></Journal><ArticleTitle>${title}</ArticleTitle><AuthorList CompleteYN="Y">${authors.join("")}</AuthorList></Article></MedlineCitation></PubmedArticle>`;

const MICH = "Department of Orthopaedic Surgery, University of Michigan, Ann Arbor, MI, USA.";
const MICH2 = "Department of Orthopaedic Surgery, University of Michigan, Ann Arbor, Michigan. Electronic address: dpark@umich.edu.";
const RUSH = "Department of Orthopaedic Surgery, Rush University Medical Center, Chicago, IL, USA.";
const SEOUL = "Department of Orthopedic Surgery, Seoul National University Hospital, Seoul, Republic of Korea.";
const xml = `<?xml version="1.0" ?><PubmedArticleSet>` + [
  article("41000001", 2026, "Meniscal root repair &amp; outcomes.", [author("Yanke", "AB", "Adam", RUSH), author("Park", "D", "Daniel", RUSH)]),
  article("38000002", 2021, "ACL graft choice in adolescents", [author("Park", "DH", "Dan", MICH)]),
  article("37000003", 2019, "Patellar instability", [author("Smith", "J", "John", MICH), author("Park", "D", "Dan", MICH2)]),
  // A different Park on the same byline search: must land in its own group, not with Dan's.
  article("39000004", 2023, "Rotator cuff tears in Korea", [author("Park", "DY", "Do-Young", SEOUL)]),
  // "Park" is a co-author but with a different initial: not a match at all.
  article("39000005", 2022, "Hip arthroscopy", [author("Park", "JS", "Jin-Su", SEOUL)]),
  // Old record with no affiliation on anyone.
  article("20000006", 2004, "Knee kinematics", [author("Park", "D", "D", "")]),
  // Accented surname in the index must still match a plain query.
  article("40000007", 2024, "&#x3b2;-catenin in cartilage", [author("Pärk", "D", "Dan", RUSH)]),
].join("") + `</PubmedArticleSet>`;

console.log("\n-- the organisation, not the department --");
check("Rush", lib.orgFromAffiliation(RUSH) === "Rush University Medical Center", lib.orgFromAffiliation(RUSH));
check("Michigan", lib.orgFromAffiliation(MICH) === "University of Michigan", lib.orgFromAffiliation(MICH));
check("an email address in the affiliation is ignored", lib.orgFromAffiliation(MICH2) === "University of Michigan", lib.orgFromAffiliation(MICH2));
check("Midwest Orthopaedics at Rush is kept as itself",
  lib.orgFromAffiliation("Midwest Orthopaedics at Rush, Chicago, Illinois, U.S.A.") === "Midwest Orthopaedics at Rush");

console.log("\n-- only the byline that is this person --");
const papers = lib.parseArticlesFor(xml, "Dan Park");
const ids = papers.map(p => p.pmid).sort();
check("finds every paper by a Dan/Daniel/D. Park", JSON.stringify(ids) === JSON.stringify(["20000006", "37000003", "38000002", "40000007", "41000001"]), ids);
check("a Park D with a different first name (Do-Young) is not him", !ids.includes("39000004"));
check("a Park with a different initial is not a match", !ids.includes("39000005"));
check("the affiliation is Park's own, not the first author's",
  papers.find(p => p.pmid === "41000001").org === "Rush University Medical Center");
check("entities are decoded in titles", papers.find(p => p.pmid === "41000001").title === "Meniscal root repair & outcomes", papers.find(p => p.pmid === "41000001").title);
check("numeric entities too", papers.find(p => p.pmid === "40000007").title.startsWith("β-catenin"));
check("year and journal come through", papers.find(p => p.pmid === "38000002").year === "2021" && papers.find(p => p.pmid === "38000002").journal === "Am J Sports Med");
check("the index form, which has no first name, can't tell Do-Young apart and keeps him for the person to judge", lib.parseArticlesFor(xml, "Park D").length === papers.length + 1);

console.log("\n-- grouped so a career can be ticked in two clicks --");
const groups = lib.clusterByOrg(lib.parseArticlesFor(xml, "Park D"));
const g = (label) => groups.find(x => x.label === label);
check("Michigan papers form one group despite different wording", g("University of Michigan") && g("University of Michigan").count === 2, groups.map(x => [x.label, x.count]));
check("Rush is its own group", g("Rush University Medical Center") && g("Rush University Medical Center").count === 2);
check("the Seoul Park is kept apart", g("Seoul National University Hospital") && g("Seoul National University Hospital").count === 1);
check("no-affiliation papers come last", groups[groups.length - 1].label === "No affiliation listed");
check("each group carries its year span", g("University of Michigan").from === 2019 && g("University of Michigan").to === 2021);

console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
