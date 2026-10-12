// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const now = new Date().toISOString();
const mockItems = [
  { id: "s1", kind: "study", data: { id: "s1", title: "Authorship Test Study", nickname: "AuthTest", pi: "Yanke", team: ["Navya", "Cade"], design: "Prospective (Consented)", phase: "Concept", priority: "Medium", irb: "ORA-7", milestones: [] }, updated_at: now },
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke", "Navya", "Cade", "Catherine Yuh"], degrees: {} }, updated_at: now }
];

const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.prompt = () => "";
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items: mockItems }) };
  }
});
const { window } = dom;
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  await wait(300);
  const doc = window.document;
  window.eval('upsertProfile("Adam Yanke")'); // admin, so every study is reachable
  await wait(60);

  // ---------- Degrees ----------
  console.log("Degree list offers the common ones:", window.eval('["BA","BS","MBA","MD","DO","PhD","MPH"].every(function(d){return DEGREE_OPTIONS.indexOf(d)>=0})') === true);
  console.log("Nobody has degrees to start:", window.eval('degreesFor("Adam Yanke").length') === 0);

  window.eval('setDegreesFor("Adam Yanke", ["MD","PhD"])');
  await wait(50);
  console.log("Degrees are multi-valued:", window.eval('JSON.stringify(degreesFor("Adam Yanke"))') === '["MD","PhD"]');
  console.log("Author name renders manuscript-style:", window.eval('authorName("Adam Yanke")') === "Adam Yanke, MD, PhD");
  console.log("Degrees resolve through name aliases too:", window.eval('authorName("Yanke")') === "Adam Yanke, MD, PhD");
  console.log("Someone with no degrees stays a bare name:", window.eval('authorName("Cade")') === "Cade Smelley");

  // Degrees ride along with the roster record so the whole team sees them
  const pushed = window.eval(`(function(){
    var it = sb.__items.filter(function(r){ return r.kind === "meta"; })[0];
    return JSON.stringify(it && it.data.degrees);
  })()`);
  console.log("Degrees sync on the shared roster record:", /"Adam Yanke":\["MD","PhD"\]/.test(pushed), pushed);

  // ---------- Degrees sheet in Settings ----------
  doc.querySelector('button[data-tab="settings"]').click();
  await wait(60);
  const degBtn = doc.querySelector('[data-degrees-for="Navya"]');
  console.log("Each team member has a Degrees button:", !!degBtn);
  degBtn.click();
  await wait(80);
  console.log("Degree sheet lists options as checkboxes:", doc.querySelectorAll(".degree-pick").length >= 7);
  const bsBox = doc.querySelector('.degree-pick[data-degree="BS"]');
  bsBox.checked = true;
  bsBox.dispatchEvent(new window.Event("change"));
  await wait(50);
  console.log("Live preview shows the manuscript form:", doc.getElementById("degree-preview").textContent === "Navya, BS");
  // free-text "Other" degree
  const other = doc.getElementById("f-degree-other");
  other.value = "MSc";
  other.dispatchEvent(new window.Event("input"));
  await wait(50);
  console.log("Other field feeds the preview:", doc.getElementById("degree-preview").textContent === "Navya, BS, MSc");
  doc.getElementById("sheet-save").click();
  await wait(80);
  console.log("Saved degrees include the custom one:", window.eval('JSON.stringify(degreesFor("Navya"))') === '["BS","MSc"]');
  console.log("Settings row shows the saved degrees:", doc.getElementById("main").innerHTML.includes("BS, MSc"));

  // ---------- Proposed Authors section ----------
  const studiesBtn = doc.querySelector('button[data-tab="studies"]');
  studiesBtn.click();
  await wait(60);
  doc.querySelector('[data-study="s1"]').click();
  await wait(60);
  // Expand the section
  const toggle = [...doc.querySelectorAll("[data-sec-toggle]")].find(t => t.textContent.includes("Proposed Authors"));
  console.log("Study page has a Proposed Authors section:", !!toggle);
  toggle.click();
  await wait(50);

  console.log("Auto-populates from the project team:", window.eval('JSON.stringify(authorsFor(state.studies[0]))') === '["Navya","Cade Smelley","Adam Yanke"]');
  console.log("PI is seeded last as senior author:", window.eval('authorsFor(state.studies[0]).slice(-1)[0]') === "Adam Yanke");
  const body = doc.getElementById("main").innerHTML;
  console.log("Renders names with their degrees:", body.includes("Navya, BS, MSc") && body.includes("Adam Yanke, MD, PhD"));
  console.log("Flags anyone still missing degrees:", body.includes("no degrees set"));

  // Reorder: move Cade (index 1) up to first author
  doc.querySelector('[data-author-up="1"]').click();
  await wait(80);
  console.log("Moving someone up reorders the list:", window.eval('JSON.stringify(authorsFor(state.studies[0]))') === '["Cade Smelley","Navya","Adam Yanke"]');
  console.log("Reordering saves an explicit order on the study:", window.eval('Array.isArray(state.studies[0].authors)') === true);

  doc.querySelector('[data-author-down="0"]').click();
  await wait(80);
  console.log("Moving someone down works too:", window.eval('JSON.stringify(authorsFor(state.studies[0]))') === '["Navya","Cade Smelley","Adam Yanke"]');

  // Add someone who isn't on the team
  const addSel = doc.getElementById("author-add");
  console.log("Can add an author from the roster:", !!addSel && [...addSel.options].some(o => o.value === "Catherine Yuh"));
  addSel.value = "Catherine Yuh";
  addSel.dispatchEvent(new window.Event("change"));
  await wait(80);
  console.log("Added author lands at the end:", window.eval('authorsFor(state.studies[0]).slice(-1)[0]') === "Catherine Yuh");

  // Remove one
  doc.querySelector('[data-author-del="1"]').click();
  await wait(80);
  console.log("Removing an author drops them:", window.eval('authorsFor(state.studies[0]).indexOf("Cade Smelley")') === -1);

  // Copy button produces the formatted list
  let copied = null;
  window.navigator.clipboard = { writeText: (t) => { copied = t; return Promise.resolve(); } };
  doc.getElementById("authors-copy").click();
  await wait(80);
  console.log("Copy button yields a manuscript-ready list:", copied === "Navya, BS, MSc, Adam Yanke, MD, PhD, Catherine Yuh", JSON.stringify(copied));

  // Reset back to the team
  doc.getElementById("authors-reset").click();
  await wait(80);
  console.log("Reset restores the team-derived list:", window.eval('JSON.stringify(authorsFor(state.studies[0]))') === '["Navya","Cade Smelley","Adam Yanke"]');
  console.log("Reset clears the saved custom order:", window.eval('state.studies[0].authors === undefined') === true);

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
