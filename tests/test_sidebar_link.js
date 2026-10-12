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
const soon = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
const mockItems = [
  { id: "s1", kind: "study", data: { id: "s1", title: "Sidebar Link Study", nickname: "SideTest", pi: "Yanke", team: [], design: "Prospective (Consented)", phase: "Concept", priority: "Medium", irb: "ORA-5", milestones: [] }, updated_at: now },
  { id: "g1", kind: "meeting", data: { id: "g1", key: "OREF|Test Grant", society: "OREF", name: "Test Grant", type: "grant", deadline: soon, studyIds: [], funded: [], hidden: false }, updated_at: now }
];

const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    // DESKTOP: this is what puts the dashboard in the side panel instead of the main pane.
    win.matchMedia = (q) => ({ matches: /min-width:\s*900px/.test(q), media: q, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items: mockItems }) };
  }
});
const { window } = dom;
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  await wait(300);
  const doc = window.document;
  window.eval('upsertProfile("Adam Yanke")');
  await wait(80);

  const sidebar = doc.getElementById("sidebar-body");
  console.log("Desktop mode puts the dashboard in the side panel:", !!sidebar && sidebar.innerHTML.length > 0);
  console.log("Side panel shows the grant deadline:", sidebar.innerHTML.includes("Test Grant"));

  const linkBtn = sidebar.querySelector('[data-link-meeting="g1"]');
  console.log("Side panel has a '＋ Link a project' button:", !!linkBtn);

  linkBtn.click();
  await wait(120);
  console.log("Link Projects sheet opened from the side panel:", !!doc.getElementById("sheet"));
  const rows = [...doc.querySelectorAll("#link-study-list .link-row")];
  console.log("Sheet lists the project:", rows.length === 1 && rows[0].textContent.includes("Sidebar Link Study"));

  const box = rows[0].querySelector(".link-study");
  console.log("Checkbox starts unticked:", box.checked === false);

  // Click the row text, exactly like tapping the project name
  rows[0].querySelector("span").click();
  await wait(60);
  console.log("Tapping the project name ticks it:", box.checked === true);

  doc.getElementById("sheet-save").click();
  await wait(120);
  console.log("Saving links the project to the grant:", window.eval('JSON.stringify(state.meetings.find(function(m){return m.id==="g1"}).studyIds)') === '["s1"]');
  console.log("Side panel now shows the linked project:", doc.getElementById("sidebar-body").innerHTML.includes("Sidebar Link Study"));

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
