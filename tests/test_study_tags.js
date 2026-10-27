// Study tags — 27 Oct 2026.
//
// Adam: tags to group studies for research meetings — body region (knee, shoulder, hip…) and
// topic (cartilage, patellofemoral instability…). Two groups, several of each per study; anyone
// can add one by typing; lab admins rename or merge; the study list filters on them (every chip
// ticked must match); saved views remember them; search finds them.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const ME = "test-user-1";
const now = new Date().toISOString();
const st = (id, title, tags) => ({ id, kind: "study", updated_at: now, workspace: "sports-yanke",
  data: { id, title, pi: "Adam Yanke", team: ["Adam Yanke"], phase: "Enrolling", design: "Prospective (Consented)", tags } });
const items = () => [
  { id: ME, kind: "profile", updated_at: now, workspace: "sports-yanke",
    data: { id: ME, email: "a@example.com", name: "Adam Yanke", position: "Clinician", reportsTo: "", alertEmail: "",
      alertEmailAsked: true, degreesAsked: true, tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: true } },
  st("s1", "OCA outcomes", { region: ["Knee"], topic: ["Cartilage"] }),
  st("s2", "MPFL saddle point", { region: ["Knee"], topic: ["Patellofemoral instability"] }),
  st("s3", "Rotator cuff PRP", { region: ["Shoulder"], topic: ["Rotator cuff", "Biologics"] }),
  st("s4", "Untagged study", undefined),
  st("s5", "TTO and PF", { region: ["Knee"], topic: ["PF instability"] }),
];
function boot() {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items: items() }) };
    } });
  return dom.window;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}
(async () => {
  const w = boot(); await wait(700);
  const ev = c => w.eval(c), d = w.document;
  const listed = () => [...d.querySelectorAll("[data-study]")].map(el => el.dataset.study).sort().join(",");

  console.log("\n-- The study list filters by tag --");
  ev(`tab = "studies"; personFilter = "all"; studyFilter = "All"; detailStudyId = null; render()`); await wait(60);
  check("tag chips show, with counts", /Knee 3/.test(d.body.textContent) && /Shoulder 1/.test(d.body.textContent) && /Cartilage 1/.test(d.body.textContent));
  check("study cards carry their tags", d.querySelector('[data-study="s1"]') && /Cartilage/.test(d.querySelector('[data-study="s1"]').textContent));
  d.querySelector('[data-tag-filter="Knee"]').click(); await wait(40);
  check("Knee shows the three knee studies", listed() === "s1,s2,s5", listed());
  d.querySelector('[data-tag-filter="Cartilage"]').click(); await wait(40);
  check("Knee + Cartilage shows only studies with both", listed() === "s1", listed());
  ev(`saveFilterSet("studies", "Knee cartilage")`); await wait(20);
  d.querySelector("[data-tag-filter-clear]").click(); await wait(40);
  check("Clear brings everything back", listed() === "s1,s2,s3,s4,s5", listed());
  const vs = ev(`JSON.stringify(state.filterSets.find(f => f.name === "Knee cartilage").filters.tags)`);
  check("a saved view remembers its tags", vs === JSON.stringify(["Knee", "Cartilage"]), vs);
  ev(`applyFilters("studies", state.filterSets.find(f => f.name === "Knee cartilage").filters); render()`); await wait(40);
  check("...and reapplies them", listed() === "s1", listed());
  ev(`studyTagFilter = []; studySearchQuery = "biologics"; render()`); await wait(40);
  check("search finds a study by its tag", listed() === "s3", listed());
  ev(`studySearchQuery = ""; render()`); await wait(20);

  console.log("\n-- Tagging a study --");
  ev(`openTagSheet("s4")`); await wait(30);
  d.querySelector('.tag-pick[data-tag-group="region"] .tag-opt[data-tag="Hip"]').click();
  d.querySelector('.tag-new[data-tag-group="topic"]').value = "femoroacetabular impingement";
  d.querySelector('.tag-new-add[data-tag-group="topic"]').click();
  d.querySelector('.tag-new[data-tag-group="topic"]').value = "hip PRESERVATION";
  d.querySelector('.tag-new-add[data-tag-group="topic"]').click();
  d.getElementById("sheet-save").click(); await wait(40);
  const t4 = JSON.parse(ev(`JSON.stringify(studyById("s4").tags)`));
  check("tap a listed tag, or type a new one", t4.region[0] === "Hip" && t4.topic.includes("femoroacetabular impingement"), t4);
  check("typing an existing tag in any case uses its spelling", t4.topic.includes("Hip preservation") && !t4.topic.includes("hip PRESERVATION"), t4);
  check("a new tag joins the lab's list", ev(`JSON.stringify(state.tagLists.topic)`).includes("femoroacetabular impingement"));
  check("...which is saved on the lab's own meta row", ev(`JSON.stringify(rosterPayload().tagLists.topic)`).includes("femoroacetabular impingement"));

  console.log("\n-- In the study form and the guided setup --");
  ev(`openStudyForm(null)`); await wait(40);
  const step3 = d.querySelector('[data-wz-step="3"]');
  check("the guided setup asks for tags on step 3", step3 && step3.querySelector('.tag-pick[data-tag-group="region"]') && step3.querySelector('.tag-pick[data-tag-group="topic"]'));
  d.getElementById("f-title").value = "Shoulder instability registry";
  d.querySelector('.tag-pick[data-tag-prefix="f"][data-tag-group="region"] .tag-opt[data-tag="Shoulder"]').click();
  d.querySelector('.tag-pick[data-tag-prefix="f"][data-tag-group="topic"] .tag-opt[data-tag="Shoulder instability"]').click();
  d.getElementById("sheet-save").click(); await wait(60);
  const made = JSON.parse(ev(`JSON.stringify(state.studies.find(s => s.title === "Shoulder instability registry").tags)`));
  check("saving the form saves the tags", made.region[0] === "Shoulder" && made.topic[0] === "Shoulder instability", made);
  ev(`openStudyForm(studyById("s1"))`); await wait(40);
  check("editing a study shows its tags already on", d.querySelector('.tag-pick[data-tag-prefix="f"] .tag-opt.on[data-tag="Cartilage"]'));
  ev(`closeSheet()`); await wait(20);

  console.log("\n-- Admins tidy the list --");
  ev(`tab = "settings"; render()`); await wait(60);
  check("Settings lists every tag with its count", /Study Tags/.test(d.body.textContent) && d.querySelector('[data-tag-rename="PF instability"]'));
  const n = ev(`renameStudyTag("topic", "PF instability", "patellofemoral instability")`);
  check("renaming onto an existing tag merges them", n === 1 && ev(`JSON.stringify(studyById("s5").tags.topic)`) === JSON.stringify(["Patellofemoral instability"]));
  check("...and the old spelling stops being offered", !ev(`JSON.stringify(tagOptions("topic"))`).includes('"PF instability"'));
  ev(`renameStudyTag("region", "Hip", "Hip & Pelvis")`);
  check("renaming a default retires the old one", !ev(`JSON.stringify(tagOptions("region"))`).includes('"Hip"') && ev(`studyById("s4").tags.region[0]`) === "Hip & Pelvis");
  check("nothing is deleted from any study", ev(`state.studies.length`) === 6);

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
