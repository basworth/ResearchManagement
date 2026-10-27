// Research-year CV on the My Lab tab — 27 Oct 2026.
//
// Adam: "the individual RA or the PI for the RA should be able to pick on that for them, let's
// change the tab from Research to My Lab and have those individuals show up at the top with an
// option to review their planned CV". A PI sees their research team (admins who report to them);
// anyone else sees themselves. The CV groups each person's ACTIVE projects by where the proposed
// author list puts them, then lists what they've published this year.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const ME = "test-user-1";
const now = new Date().toISOString();
const YEAR = String(new Date().getFullYear());
const prof = (id, name, extra) => ({ id, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: Object.assign({ id, email: id + "@example.com", name, position: "Research Assistant", reportsTo: "", alertEmail: "",
    alertEmailAsked: true, degreesAsked: true, tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: false }, extra || {}) });
const st = (id, data) => ({ id, kind: "study", updated_at: now, workspace: "sports-yanke", data: Object.assign({ id, design: "Prospective (Consented)", pi: "Adam Yanke" }, data) });
const items = (meAdmin) => [
  prof(ME, meAdmin ? "Adam Yanke" : "William Lee", meAdmin ? { admin: true, position: "Clinician" } : {}),
  prof("will", meAdmin ? "William Lee" : "Adam Yanke", meAdmin ? { admin: true, reportsTo: ME } : { admin: true, position: "Clinician" }),
  prof("tj", "Thomas Turinske", { admin: true, reportsTo: meAdmin ? ME : "will" }),
  prof("carla", "Carla Coordinator", { admin: true, reportsTo: meAdmin ? ME : "will", position: "Research manager (CRCM)" }),
  prof("crc", "Casey Crc", { admin: true, reportsTo: meAdmin ? ME : "will", position: "CRC" }),
  st("s1", { title: "OCA return to sport", phase: "Manuscript", authors: ["William Lee", "Cade Smelley", "Adam Yanke"], team: ["William Lee"] }),
  st("s2", { title: "MPFL registry", phase: "Enrolling", team: ["Adam Yanke", "Thomas Turinske", "William Lee"] }),
  st("s3", { title: "Saddle point", phase: "Submitted", authors: ["Cade Smelley", "William Lee", "Adam Yanke"], journal: "AJSM" }),
  st("s4", { title: "Old paper", phase: "Published", authors: ["William Lee", "Adam Yanke"] }),
  st("s5", { title: "Team-only project", phase: "Concept", authors: ["Cade Smelley", "Adam Yanke"], team: ["William Lee"] }),
  st("s6", { title: "Pub this year", phase: "Published", publication: { pmid: "1", year: YEAR, title: "A paper", journal: "AJSM",
    authors: [{ last: "Lee", fore: "William" }, { last: "Yanke", fore: "Adam" }] } }),
];
function boot(meAdmin) {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items: items(meAdmin) }) };
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
  const w = boot(true); await wait(700);
  const ev = c => w.eval(c), d = w.document;
  console.log("\n-- The tab is My Lab --");
  check("the tab reads My Lab", /My Lab/.test(d.querySelector('[data-tab="research"]').textContent));
  ev(`tab = "research"; render()`); await wait(80);
  console.log("\n-- A PI sees their research team at the top --");
  const opens = [...d.querySelectorAll("[data-cv-open]")].map(b => b.dataset.cvOpen).sort();
  check("one card per person on their team", JSON.stringify(opens) === JSON.stringify(["Thomas Turinske", "William Lee"]), opens);
  check("the cards come first on the page", d.querySelector("[data-cv-open]").closest(".card") === d.querySelectorAll(".card")[0]);
  const cardText = d.querySelector('[data-cv-open="William Lee"]').closest(".card").textContent;
  check("each card counts first / second / other", /1 first · 1 second · 1 other · 1 published/.test(cardText.replace(/\s+/g, " ")), cardText);
  check("an admin can pick anyone else", !!d.getElementById("cv-pick"));
  check("no CV card for a CRCM or CRC", !opens.some(n => /Carla|Casey/.test(n)), opens);
  check("...nor in the picker", ![...d.querySelectorAll("#cv-pick option")].some(o => /Carla|Casey/.test(o.value)));
  d.querySelector('[data-cv-open="William Lee"]').click(); await wait(60);
  const t = d.body.textContent.replace(/\s+/g, " ");
  console.log("\n-- The CV --");
  const sec = (label) => { const h = [...d.querySelectorAll(".section-title")].find(x => x.textContent.startsWith(label)); return h ? h.nextElementSibling.textContent : ""; };
  check("first author: where the proposed list puts them first", /OCA return to sport/.test(sec("First author")));
  check("second author", /Saddle point/.test(sec("Second author")));
  check("other author, including from a team-built list", /MPFL registry/.test(sec("Other author")));
  check("on the team but not the author list", /Team-only project/.test(sec("On the team")));
  check("published studies aren't counted as active", !/Old paper/.test(sec("First author") + sec("Other author")));
  check("this year's papers, with their place", /A paper/.test(sec("Published in " + YEAR)) && /First/.test(sec("Published in " + YEAR)));
  check("each row shows the phase and position", /Author 2 of 3/.test(t) && /Submitted/.test(t));
  d.getElementById("cv-back").click(); await wait(40);
  check("Back returns to My Lab", !!d.querySelector("[data-cv-open]"));
  console.log("\n-- An RA sees themselves --");
  const w2 = boot(false); await wait(700);
  w2.eval(`tab = "research"; render()`); await wait(80);
  const mine = [...w2.document.querySelectorAll("[data-cv-open]")].map(b => b.dataset.cvOpen);
  check("just their own card", JSON.stringify(mine) === JSON.stringify(["William Lee"]), mine);
  check("and no picker for other people", !w2.document.getElementById("cv-pick"));
  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
