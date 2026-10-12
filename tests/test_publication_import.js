// The import's judgement, tested on its own: which papers attach to a study you already track,
// which become new records, and which it refuses to guess at. Getting this wrong either
// duplicates live studies or silently overwrites them, so the thresholds are worth pinning down.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");

const src = fs.readFileSync(PROJECT + "/supabase/functions/import-publications/index.ts", "utf8");

// Lift the two pure functions out of the TypeScript source rather than duplicating them here —
// a copy would drift, and then the test would be checking something the function doesn't do.
const normSrc = src.slice(src.indexOf("const norm ="), src.indexOf("function titleOverlap"));
const overlapSrc = src.slice(src.indexOf("function titleOverlap"), src.indexOf("Deno.serve"));
const strip = (t) => t.replace(/: *string/g, "").replace(/: *number/g, "").replace(/\): *\w+ *\{/, ") {");
const { norm, titleOverlap } = new Function(strip(normSrc) + strip(overlapSrc) + "; return { norm, titleOverlap };")();

let pass = 0, fail = 0;
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);

// The thresholds the function uses, restated here so a change to either is deliberate.
const ATTACH = 0.75, MARGIN = 1.3;
function decide(paperTitle, studyTitles) {
  const scored = studyTitles.map(t => ({ t, score: titleOverlap(paperTitle, t) })).sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (best && best.score >= ATTACH && (!second || best.score >= second.score * MARGIN)) return { verdict: "attach", to: best.t, score: +best.score.toFixed(2) };
  if (best && best.score >= ATTACH) return { verdict: "ambiguous", score: +best.score.toFixed(2) };
  return { verdict: "create", score: best ? +best.score.toFixed(2) : 0 };
}

console.log("\n-- Titles that are the same work --");
check("PubMed's trailing full stop and capitals don't matter",
  norm("Patellofemoral Cartilage Injury and Treatment.") === norm("patellofemoral cartilage injury and treatment"));
check("A tracked study matches its published paper",
  decide("Isolated Medial Patellofemoral Ligament Reconstruction Reduces Patellar Height and Is Associated With Quadriceps Dysfunction",
    ["Isolated MPFL reconstruction reduces patellar height and is associated with quadriceps dysfunction",
     "Bone Shape as an Independent Risk Factor for Patellofemoral Cartilage Damage"]).verdict === "attach");

console.log("\n-- Titles that are different work --");
const unrelated = decide(
  "Quadriceps Tendon Autograft Harvest Technique Affects Both Graft Strength and Cross-sectional Area",
  ["Bone Shape as an Independent Risk Factor for Patellofemoral Cartilage Damage",
   "Cartilage Health and Subchondral Integration Following Modified Recession Wedge Trochleoplasty"]);
check("an unrelated paper becomes a new record, not an attachment", unrelated.verdict === "create", unrelated);

console.log("\n-- Near-identical studies are handed back, not guessed between --");
// Two sibling studies that differ in one word is exactly the shape that caused trouble with the
// email matcher: close enough to score high against both, so neither should win silently.
const twins = decide(
  "Medial Patellofemoral Ligament Reconstruction Outcomes in Adolescent Patients",
  ["Medial Patellofemoral Ligament Reconstruction Outcomes in Adolescent Patients",
   "Medial Patellofemoral Ligament Reconstruction Outcomes in Adult Patients"]);
check("a paper matching two studies closely is flagged, not attached",
  twins.verdict === "ambiguous", twins);

console.log("\n-- Scoring behaves sensibly --");
check("identical titles score 1", titleOverlap("Microfracture dead or the future", "Microfracture: dead or the future?") === 1);
check("nothing in common scores 0", titleOverlap("Rotator cuff repair outcomes", "Ethanol exposure in mice") === 0);
check("short words are ignored, so 'the' and 'and' can't carry a match",
  titleOverlap("the and for with of", "the and for with of") === 0);

console.log("\n-- The function itself --");
check("it defaults to NOT writing", /const dryRun = body\.dryRun !== false/.test(src));
check("it requires an admin", /Admins only/.test(src));
check("it identifies the caller from their own token", /auth\.getUser\(\)/.test(src));
check("it uses the full forename, not initials", /Full Author Name/.test(src) && /Yanke Adam B/.test(src));
check("it carries no WASM XML parser — that bundle broke the function",
  !/^\s*import[^\n]*deno_dom/m.test(src));
check("...and doesn't reach for the browser's DOMParser either", !/new DOMParser\(/.test(src));
check("it never deletes", !/\.delete\(/.test(src));
check("it only reads studies from one workspace", /\.eq\("workspace", workspace\)/.test(src));
check("it stamps every row it writes", /workspace,\s*updated_at/.test(src));
check("a paper already linked is skipped", /alreadyLinked/.test(src));
check("it reports what it matched so the judgement can be checked", /attached,/.test(src) && /ambiguous,/.test(src));
check("it answers the browser's CORS preflight", /OPTIONS/.test(src) && /Access-Control-Allow-Origin/.test(src));
check("...and every reply carries the headers, not just the happy path",
  !/Response\.json\(/.test(src), "still using Response.json somewhere");


console.log("\n-- Reading PubMed's XML --");
{
  const block = src.slice(src.indexOf("function unescapeXml"), src.indexOf("// Title matching has to tolerate"));
  const stripTs = t => t.replace(/: *string\[\]/g, "").replace(/: *string/g, "").replace(/: *Paper\[\]/g, "")
    .replace(/: *Author\[\]/g, "").replace(/: *RegExpExecArray \| null/g, "")
    .replace(/const out: *\w+\[\] *=/g, "const out =").replace(/\): *\w+(\[\])? *\{/g, ") {")
    .replace(/^type [\s\S]*?};$/gm, "");
  const { parseArticles } = new Function(stripTs(block) + "; return { parseArticles };")();
  // A record shaped like the real thing, including the traps: a PMID repeated inside a reference
  // list, an entity in the title, and the DOI sitting among other ArticleIds.
  const xml = `<PubmedArticleSet><PubmedArticle><MedlineCitation Status="MEDLINE">
<PMID Version="1">42490302</PMID>
<Article><Journal><ISOAbbreviation>Arthroscopy</ISOAbbreviation>
<JournalIssue><PubDate><Year>2026</Year></PubDate></JournalIssue></Journal>
<ArticleTitle>Isolated MPFL Reconstruction &amp; Patellar Height.</ArticleTitle>
<AuthorList><Author><LastName>Sachdev</LastName><ForeName>Divesh</ForeName><Initials>D</Initials></Author>
<Author><LastName>Yanke</LastName><ForeName>Adam B</ForeName><Initials>AB</Initials></Author></AuthorList></Article>
<ReferenceList><Reference><ArticleIdList><ArticleId IdType="pubmed">11111111</ArticleId></ArticleIdList></Reference></ReferenceList>
</MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">42490302</ArticleId>
<ArticleId IdType="doi">10.1002/arj.70422</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>`;
  const [p] = parseArticles(xml);
  check("the article's own PMID, not one from its reference list", p.pmid === "42490302", p.pmid);
  check("the DOI is picked by its IdType", p.doi === "10.1002/arj.70422", p.doi);
  check("journal and year", p.journal === "Arthroscopy" && p.year === "2026", [p.journal, p.year]);
  check("the title's entity is decoded", p.title.includes("&") && !p.title.includes("&amp;"), p.title);
  check("every author, in order", p.authorList === "Divesh Sachdev, Adam B Yanke", p.authorList);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
