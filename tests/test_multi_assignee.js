// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    // Pre-authenticated mock Supabase client - bootApp() signs itself in against this instead
    // of hitting the real network, so the app unlocks past the login screen immediately.
    win.supabase = { createClient: () => makeMockSupabase({ items: [] }) };
  }
});
const { window } = dom;

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  await wait(300);
  const doc = window.document;

  const settingsBtn = doc.querySelector('button[data-tab="settings"]');
  settingsBtn.click();
  await wait(50);
  const loadSampleBtn = [...doc.querySelectorAll('button')].find(b => b.textContent.includes("Load Sample Data"));
  if (loadSampleBtn) { loadSampleBtn.click(); await wait(50); }

  const tasksBtn = doc.querySelector('button[data-tab="tasks"]');
  tasksBtn.click();
  await wait(50);
  // The Tasks tab now opens on "Mine"; switch to "Open" so this test sees every seeded task
  // regardless of who they're assigned to.
  [...doc.querySelectorAll(".seg button")].find(b => b.textContent.trim() === "Open").click();
  await wait(50);

  // Seed data includes a task with 2 assignees: "Draft methods section" -> Adam, Chen
  let mainHTML = doc.getElementById("main").innerHTML;
  console.log("Multi-assignee task shows both names joined:", mainHTML.includes("Adam, Chen"));

  // Open that task and confirm the field shows the joined names
  const taskBody = [...doc.querySelectorAll("[data-task]")].find(el => el.textContent.includes("Draft methods section"));
  console.log("Found the multi-assignee task row:", !!taskBody);
  taskBody.click();
  await wait(50);
  // The single comma-separated field was replaced by a tick list (see test_assignee_picker.js),
  // so editing means ticking rather than typing.
  const picks = () => [...doc.querySelectorAll(".f-tassignee-pick")];
  const ticked = picks().filter(c => c.checked).map(c => c.dataset.name);
  console.log("Existing assignees pre-ticked on edit:", ticked.join(", "));

  // Add a third assignee by ticking them. Exact match, not a regex: the sample data contains
  // BOTH "Lee" and "Lee (fellow)" as separate people, and a loose /Lee/i match picks whichever
  // renders first — which then isn't the person the "Mine" check below signs in as.
  console.log("Names offered:", picks().map(c => c.dataset.name).join(" | "));
  const lee = picks().find(c => c.dataset.name === "Lee (fellow)");
  console.log("Found a checkbox for exactly \"Lee (fellow)\":", !!lee);
  lee.checked = true;
  doc.getElementById("sheet-save").click();
  await wait(80);

  mainHTML = doc.getElementById("main").innerHTML;
  const three = window.eval('JSON.stringify((state.tasks.filter(function(t){return t.title==="Draft methods section";})[0]||{}).assignees||[])');
  console.log("Task now has three assignees:", JSON.parse(three).length === 3, three);

  // Test "Mine" filter matches when the current user is one of several assignees.
  // Identity is now profile-based (tied to the authenticated user), not a free-text localStorage
  // value, so set it via the same upsertProfile() call the "Display name" field in Settings uses.
  window.eval('upsertProfile("Lee (fellow)")');
  const filterMineBtn = [...doc.querySelectorAll(".seg button")].find(b => b.textContent.trim() === "Mine");
  filterMineBtn.click();
  await wait(50);
  mainHTML = doc.getElementById("main").innerHTML;
  console.log("Mine filter matches task where Lee (fellow) is one of several assignees:", mainHTML.includes("Draft methods section"));

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
