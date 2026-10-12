// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Guards against the Safari "invisible checkbox" class of bug: the app's generic
// ".frow input" rule sets background:none, which removes a checkbox's native rendering in
// WebKit. jsdom doesn't render CSS, so instead of measuring pixels this asserts the SOURCE
// carries a global checkbox rule and that no checkbox re-declares a background that would
// re-break it. It also checks every checkbox row is tappable, not just the checkbox itself.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const path = PROJECT + "/research-tracker.html";
const html = fs.readFileSync(path, "utf8");

// ---------- Static source checks ----------
const hasGlobalRule = /input\[type="checkbox"\]\s*\{[^}]*appearance:\s*checkbox/.test(html);
console.log("A global rule restores native checkbox rendering:", hasGlobalRule);
const ruleBody = (html.match(/input\[type="checkbox"\]\s*\{([^}]*)\}/) || [])[1] || "";
console.log("...and it resets the background that Safari needs:", /background:\s*initial/.test(ruleBody));
console.log("...and pins a tappable size:", /width:\s*22px/.test(ruleBody) && /height:\s*22px/.test(ruleBody));

// No checkbox should carry an inline background:none — that would re-break Safari.
const inlineBad = (html.match(/<input[^>]*type="checkbox"[^>]*background:\s*none[^>]*>/g) || []);
console.log("No checkbox re-declares background:none inline:", inlineBad.length === 0, inlineBad.length ? inlineBad[0].slice(0, 90) : "");

const now = new Date().toISOString();
const mockItems = [
  { id: "s1", kind: "study", data: { id: "s1", title: "Checkbox Study", nickname: "CBX", pi: "Yanke", team: ["Navya"], design: "Prospective (Consented)", phase: "Concept", priority: "Medium", irb: "ORA-9", milestones: [] }, updated_at: now },
  { id: "m1", kind: "meeting", data: { id: "m1", key: "AANA|CBX Meeting", society: "AANA", name: "CBX Meeting", type: "abstract", deadline: "2027-09-01", studyIds: [], funded: [], hidden: false }, updated_at: now },
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke", "Navya"], degrees: {} }, updated_at: now }
];

const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items: mockItems }) };
  }
});
const { window } = dom;
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// A checkbox row counts as usable if tapping its text label toggles the box.
function rowTogglesFromText(row) {
  const box = row.querySelector('input[type="checkbox"]');
  const text = row.querySelector("span");
  if (!box || !text) return false;
  const before = box.checked;
  text.click();
  return box.checked === !before;
}

(async () => {
  await wait(300);
  const doc = window.document;
  window.eval('upsertProfile("Adam Yanke")');
  await wait(60);

  // ---------- Degrees sheet (the one that was broken) ----------
  doc.querySelector('button[data-tab="settings"]').click();
  await wait(60);
  doc.querySelector('[data-degrees-for="Navya"]').click();
  await wait(80);
  const degRows = [...doc.querySelectorAll(".degree-row")];
  console.log("Degree sheet renders its options:", degRows.length >= 7);
  console.log("Degree rows are tappable on the label text:", rowTogglesFromText(degRows[0]));
  console.log("Tapping a degree row twice returns it to the start:", rowTogglesFromText(degRows[0]));
  console.log("Degree checkboxes carry no size-killing inline style:", !degRows[0].querySelector("input").getAttribute("style"));
  doc.getElementById("sheet-cancel").click();
  await wait(60);

  // ---------- Team picker in the study form ----------
  doc.querySelector('button[data-tab="studies"]').click();
  await wait(60);
  doc.querySelector('[data-study="s1"]').click();
  await wait(60);
  doc.getElementById("edit-study-btn").click();
  await wait(80);
  const teamRows = [...doc.querySelectorAll(".team-row")];
  console.log("Team picker renders rows:", teamRows.length > 0);
  console.log("Team rows are tappable on the label text:", rowTogglesFromText(teamRows[0]));
  doc.getElementById("sheet-cancel").click();
  await wait(60);

  // ---------- Link Projects sheet ----------
  window.eval('openLinkSheet("m1")');
  await wait(80);
  const linkRows = [...doc.querySelectorAll(".link-row")];
  console.log("Link sheet renders rows:", linkRows.length > 0);
  console.log("Link rows are tappable on the label text:", rowTogglesFromText(linkRows[0]));
  doc.getElementById("sheet-cancel").click();
  await wait(60);

  // ---------- Every other checkbox in the app still renders ----------
  doc.querySelector('button[data-tab="settings"]').click();
  await wait(60);
  const subToggles = doc.querySelectorAll(".sub-toggle");
  console.log("Society subscription toggles present:", subToggles.length > 0);
  console.log("Society toggles are real checkboxes:", [...subToggles].every(c => c.type === "checkbox"));

  window.eval('openMeetingForm(state.meetings[0])');
  await wait(80);
  console.log("Deadline form's Unconfirmed + Not-submitting boxes present:",
    !!doc.getElementById("f-municonf") && !!doc.getElementById("f-mhidden"));

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
