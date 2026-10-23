// Confirm your publications: the app half — 23 Oct 2026.
//
// Adam, 22 Oct: "Park was at Michigan, so stuff he did in the past is still going to be relevant."
// One institution filter deleted Dan Park's Michigan career from his own feed. The person now
// ticks their papers once, grouped by institution, and the lab's watchConfig keeps:
//   ownPmids (the ticks), institutions (where they came from), notMine (what was left unticked).
//
// What this pins:
//   - nothing is confirmed by pressing Save without reading: only institutions the lab already
//     named start ticked, and an earlier answer always wins over that default
//   - a group checkbox ticks/unticks its papers, and saving writes exactly what is on screen
//   - earlier confirmations outside this (capped) lookup are kept, not lost
//   - steering is the owner's: a lab member who can't steer gets neither the sheet nor the nudge
//   - "Later" means later
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const PI = "test-user-1", RA = "test-user-2";
const now = new Date().toISOString();
const prof = (id, name, admin) => ({
  id, kind: "profile", updated_at: now, workspace: "spine-park",
  data: { id, email: name.toLowerCase().replace(/ /g, ".") + "@rushortho.com", name,
    position: admin ? "Clinician" : "Research Assistant", reportsTo: "", alertEmail: "",
    alertEmailAsked: true, degreesAsked: true, tourSeen: 1, fieldsChosen: true, linkedTo: "",
    admin: !!admin },
});
const cfgRow = (extra) => ({
  id: "cfg", kind: "watchConfig", updated_at: now, workspace: "spine-park",
  data: Object.assign({ workspace: "spine-park", authors: ["Dan Park"], keywords: ["spine"],
    institution: "Rush", excludeAuthors: [], excludeKeywords: [], societies: [], enabled: true,
    ownerId: PI, tuners: [] }, extra || {}),
});
const REPLY = {
  ok: true, name: "Dan Park", totalWithName: 9000, matched: 6, shown: 6, narrowed: true,
  clusters: [
    { key: "rush university medical center", org: "Rush University Medical Center", label: "Rush University Medical Center", count: 2, from: 2024, to: 2026,
      papers: [{ pmid: "41000001", title: "Rush paper A", journal: "Spine", year: "2026" }, { pmid: "40000007", title: "Rush paper B", journal: "Spine J", year: "2024" }] },
    { key: "university of michigan", org: "University of Michigan", label: "University of Michigan", count: 2, from: 2019, to: 2021,
      papers: [{ pmid: "38000002", title: "Michigan A", journal: "AJSM", year: "2021" }, { pmid: "37000003", title: "Michigan B", journal: "AJSM", year: "2019" }] },
    { key: "seoul national university hospital", org: "Seoul National University Hospital", label: "Seoul National University Hospital", count: 1, from: 2023, to: 2023,
      papers: [{ pmid: "39000004", title: "A stranger's paper", journal: "KJ", year: "2023" }] },
    { key: "none", org: "", label: "No affiliation listed", count: 1, from: 2004, to: 2004,
      papers: [{ pmid: "20000006", title: "Old one", journal: "JBJS", year: "2004" }] },
  ],
};

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}
const calls = [];
function boot(items) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.fetch = async (url, init) => {
        if (String(url).includes("/functions/v1/research-watch")) {
          calls.push(JSON.parse((init && init.body) || "{}"));
          return { ok: true, status: 200, json: async () => REPLY };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      };
      win.supabase = { createClient: () => makeMockSupabase({ items }) };
    },
  });
  return dom.window;
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  let w = boot([prof(PI, "Dan Park", true), prof(RA, "A Resident", false), cfgRow()]);
  await wait(700);
  const ev = (c) => w.eval(c);
  const d = w.document;
  ev(`myWorkspace = "spine-park"; tab = "research"; render();`);
  ev(`sb.auth.getSession = async () => ({ data: { session: { user: { id: "${PI}" }, access_token: "t" } } });`);
  await wait(150);

  console.log("\n-- The nudge appears for the owner until they confirm --");
  check("the Research tab asks the owner which papers are theirs", !!d.getElementById("cp-nudge"));

  console.log("\n-- Looking it up asks the server for this name, in this lab --");
  d.getElementById("cp-nudge-go").click();
  await wait(300);
  const call = calls[calls.length - 1] || {};
  check("identify is called with the name and the lab", call.action === "identify" && call.name === "Dan Park" && call.workspace === "spine-park", call);
  const sheet = d.getElementById("sheet");
  check("the sheet lists every institution", sheet && ["Rush University Medical Center", "University of Michigan", "Seoul National University Hospital", "No affiliation listed"].every(t => sheet.textContent.includes(t)));
  check("it says the list was narrowed, and why", /orthopaedic and spine/.test(sheet.textContent));

  console.log("\n-- Nothing is confirmed without reading --");
  const box = (pmid) => sheet.querySelector(`[data-cp-pmid="${pmid}"]`);
  const group = (key) => sheet.querySelector(`[data-cp-group="${key}"]`);
  check("the institution the lab already named starts ticked", box("41000001").checked && box("40000007").checked && group("rush university medical center").checked);
  check("Michigan starts unticked — he has to say so", !box("38000002").checked && !group("university of michigan").checked);
  check("the stranger starts unticked", !box("39000004").checked);

  console.log("\n-- Ticking a group ticks its papers; one can then be unticked --");
  const mich = group("university of michigan");
  mich.checked = true; mich.dispatchEvent(new w.Event("change"));
  check("both Michigan papers are now ticked", box("38000002").checked && box("37000003").checked);
  box("37000003").checked = false; box("37000003").dispatchEvent(new w.Event("change"));
  check("unticking one leaves the group part-ticked", mich.indeterminate === true && mich.checked === false);
  box("37000003").checked = true; box("37000003").dispatchEvent(new w.Event("change"));

  console.log("\n-- Saving writes exactly what is on screen --");
  d.getElementById("sheet-save").click();
  await wait(200);
  const cfg = ev(`JSON.parse(JSON.stringify(state.watchConfig))`);
  check("ownPmids are the ticks, newest first", JSON.stringify(cfg.ownPmids) === JSON.stringify(["41000001", "40000007", "38000002", "37000003"]), cfg.ownPmids);
  check("institutions are where the ticks came from", JSON.stringify(cfg.institutions) === JSON.stringify(["Rush University Medical Center", "University of Michigan"]), cfg.institutions);
  check("the unticked are remembered as not his", cfg.notMine.includes("39000004") && cfg.notMine.includes("20000006") && !cfg.notMine.includes("38000002"), cfg.notMine);
  check("it is stamped as confirmed", !!cfg.identifiedAt);
  check("the rest of the config is untouched", cfg.institution === "Rush" && cfg.keywords[0] === "spine" && cfg.ownerId === PI);
  check("...and it reached the database", ev(`!!sb`) && /41000001/.test(JSON.stringify(ev(`JSON.stringify(state.watchConfig)`))));
  ev(`render();`); await wait(100);
  check("the nudge is gone once confirmed", !d.getElementById("cp-nudge"));

  console.log("\n-- An earlier answer wins, and confirmations outside this lookup survive --");
  const next = ev(`JSON.stringify(cpNextConfig(
    Object.assign({}, state.watchConfig, { ownPmids: state.watchConfig.ownPmids.concat(["11111111"]) }),
    ${JSON.stringify(REPLY.clusters)},
    cpInitialTicks(Object.assign({}, state.watchConfig, { ownPmids: state.watchConfig.ownPmids.concat(["11111111"]) }), ${JSON.stringify(REPLY.clusters)}),
    "2026-10-23T00:00:00Z"))`);
  const n2 = JSON.parse(next);
  check("re-opening starts from the saved answer (Michigan stays ticked)", n2.ownPmids.includes("38000002") && n2.ownPmids.includes("37000003"));
  check("the stranger stays not-his", !n2.ownPmids.includes("39000004") && n2.notMine.includes("39000004"));
  check("a confirmation the lookup didn't return is kept", n2.ownPmids.includes("11111111"));

  console.log("\n-- Steering is the owner's --");
  ev(`currentUser = { id: ${JSON.stringify(RA)}, email: "a.resident@rushortho.com" }; tab = "research"; render();`);
  await wait(150);
  check("a lab member who can't steer gets no nudge", !d.getElementById("cp-nudge"));
  const before = calls.length;
  ev(`openConfirmPubsSheet()`); await wait(150);
  check("...and no lookup either", calls.length === before);

  console.log("\n-- Later means later --");
  w = boot([prof(PI, "Dan Park", true), cfgRow()]);
  await wait(700);
  w.eval(`myWorkspace = "spine-park"; tab = "research"; render();`); await wait(150);
  w.document.getElementById("cp-nudge-later").click(); await wait(50);
  w.eval(`render();`); await wait(100);
  check("after Later, the nudge stays away", !w.document.getElementById("cp-nudge"));

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
