// Settings layout — 27 Oct 2026. Adam: "this whole page is getting a little hard to manage, the
// things that we don't use as often should be put into a menu and the items that show at the top
// should be the ones we need to act on most often like meeting and email summaries."
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const ME = "test-user-1";
const now = new Date().toISOString();
const items = () => [
  { id: ME, kind: "profile", updated_at: now, workspace: "sports-yanke",
    data: { id: ME, email: "a@example.com", name: "Adam Yanke", position: "Clinician", reportsTo: "", alertEmail: "",
      alertEmailAsked: true, degreesAsked: true, tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: true } },
  { id: "s1", kind: "study", updated_at: now, workspace: "sports-yanke", data: { id: "s1", title: "OCA outcomes", phase: "Enrolling", pi: "Adam Yanke", team: ["Adam Yanke"],
    tagSuggestion: { region: ["Knee"], topic: ["Cartilage"] } } },
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
  ev(`tab = "settings"; render()`); await wait(80);
  const main = d.getElementById("main") || d.querySelector("main") || d.body;
  const act = d.getElementById("settings-act");
  console.log("\n-- What you act on is at the top, open --");
  check("the act-on block comes first", act && [...act.parentElement.children].indexOf(act) === 0);
  check("it holds Suggested Updates", act && /Suggested Updates/.test(act.textContent));
  check("...and Suggested Tags", act && !!act.querySelector("#tag-review"));
  check("...and is not folded", act && !act.closest("details"));
  console.log("\n-- Everything else folds into a menu of groups --");
  const groups = [...d.querySelectorAll("details.settings-group")].map(g => g.dataset.sg);
  ["Help & tools", "Account", "Team list", "Study Tags", "Merge Duplicate Names", "Org Chart", "Deadline Subscriptions", "Data", "About"]
    .forEach(k => check(`"${k}" is its own folded group`, groups.includes(k), groups));
  const cats = [...d.querySelectorAll(".settings-category")].map(c => c.dataset.cat);
  check("groups sit under headings", ["Account & user settings", "People & access", "Lab setup", "Help, data & about"].every(c => cats.includes(c)), cats);
  const under = (k) => { let n = d.querySelector(`details.settings-group[data-sg="${k}"]`); while (n && !(n.classList && n.classList.contains("settings-category"))) n = n.previousElementSibling; return n && n.dataset.cat; };
  check("Account and Deadline Subscriptions are under Account & user settings", under("Account") === "Account & user settings" && under("Deadline Subscriptions") === "Account & user settings");
  check("Org Chart and Invite are under People & access", under("Org Chart") === "People & access" && under("Invite a Teammate") === "People & access");
  check("Study Tags and Merge names are under Lab setup", under("Study Tags") === "Lab setup" && under("Merge Duplicate Names") === "Lab setup");
  check("all start closed", [...d.querySelectorAll("details.settings-group")].every(g => !g.open));
  check("buttons inside still work (ids kept)", !!d.getElementById("sign-out-btn") && !!d.getElementById("settings-help").onclick);
  const org = d.querySelector('details.settings-group[data-sg="Org Chart"]');
  org.open = true; org.dispatchEvent(new w.Event("toggle"));
  ev(`render()`); await wait(80);
  check("a group you opened stays open after the page redraws", d.querySelector('details.settings-group[data-sg="Org Chart"]').open === true);
  check("the org-chart jump anchor survives", !!d.getElementById("org-anchor"));
  console.log("\n-- Already merged is folded too --");
  ev(`state.nameAliases = { "anu": "Arnavaz(Anu) Hakimiyan" }; render()`); await wait(80);
  const am = [...d.querySelectorAll("details summary")].find(s => /ALREADY MERGED \(1\)/.test(s.textContent));
  check("Already merged is a closed fold with its count", am && !am.parentElement.open);
  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
