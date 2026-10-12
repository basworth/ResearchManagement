// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

// Simulate the real-world race that created the live-site bug: two independent meeting rows
// sharing the same feed "key" ("AANA|2027 Annual Meeting"), one of them already linked to a
// study and referenced by an auto-created submission task. migrate() should merge these down
// to one record on load, repointing the task rather than orphaning it.
const studyId = "test-study-1";
const dupAId = "dup-a-unlinked";
const dupBId = "dup-b-linked";
const taskId = "orphan-task-1";
const craftedState = {
  studies: [{ id: studyId, title: "Test Study For Dedupe", design: "Prospective (Consented)", phase: "Concept", priority: "Medium" }],
  tasks: [{ id: taskId, title: "Submit abstract: 2027 Annual Meeting", studyId, due: "2026-08-10", assignees: [], notes: "", done: false, linkedMeetingId: dupAId }],
  roster: [],
  meetings: [
    { id: dupAId, key: "AANA|2027 Annual Meeting", society: "AANA", name: "2027 Annual Meeting", type: "abstract", deadline: "2026-08-10", dates: "", location: "", link: "", aim: "", criteria: "", funded: [], studyIds: [], unconfirmed: false, verifiedOn: "2026-07-13T18:45" },
    { id: dupBId, key: "AANA|2027 Annual Meeting", society: "AANA", name: "2027 Annual Meeting", type: "abstract", deadline: "2026-08-10", dates: "", location: "", link: "", aim: "", criteria: "", funded: [], studyIds: [studyId], unconfirmed: false, verifiedOn: "2026-07-10T09:00" }
  ],
  teamNotes: []
};

// Mirror the crafted state as "remote" rows so pullAll() (which now runs right after the mock
// sign-in) pulls the duplicate meetings itself and migrate() dedupes them, same as the real flow.
const now = new Date().toISOString();
const mockItems = [
  { id: studyId, kind: "study", data: craftedState.studies[0], updated_at: now },
  { id: taskId, kind: "task", data: craftedState.tasks[0], updated_at: now },
  { id: dupAId, kind: "meeting", data: craftedState.meetings[0], updated_at: now },
  { id: dupBId, kind: "meeting", data: craftedState.meetings[1], updated_at: now }
];

const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1"); // skip the first-launch SEED_FEED merge so the test stays isolated
    // Pre-authenticated mock Supabase client seeded with the crafted duplicate-meeting scenario —
    // pullAll() fetches these as "remote" rows right after sign-in, and migrate() should dedupe them.
    win.supabase = { createClient: () => makeMockSupabase({ items: mockItems }) };
  }
});
const { window } = dom;

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  await wait(300);
  const doc = window.document;

  const studiesBtn = doc.querySelector('button[data-tab="studies"]');
  studiesBtn.click();
  await wait(50);
  const card = doc.querySelector('.study-row');
  console.log("Test study loaded:", !!card && card.textContent.includes("Test Study For Dedupe"));
  card.click();
  await wait(50);

  const rows = doc.querySelectorAll('[data-open-meeting]');
  console.log("Exactly one deadline row rendered (duplicate merged away):", rows.length === 1);
  console.log("Survivor still shows the AANA abstract deadline:", doc.getElementById("main").innerHTML.includes("2027 Annual Meeting"));

  const tasksBtn = doc.querySelector('button[data-tab="tasks"]');
  tasksBtn.click();
  await wait(50);
  // Tasks now opens on "Mine"; switch to "Open" so every seeded task is in view here.
  [...doc.querySelectorAll(".seg button")].find(function(b){return b.textContent.trim()==="Open"}).click();
  await wait(50);
  const taskBodies = [...doc.querySelectorAll("[data-task]")].filter(el => el.textContent.includes("Submit abstract: 2027 Annual Meeting"));
  console.log("Exactly one submission task shown (not duplicated, not lost):", taskBodies.length === 1);

  taskBodies[0].click();
  await wait(50);
  const gotoMeetingBtn = doc.getElementById("f-tgoto-meeting");
  console.log("Task's View Deadline button present after repoint:", !!gotoMeetingBtn);
  gotoMeetingBtn.click();
  await wait(50);
  console.log("Clicking View Deadline opens the surviving meeting without error:", !!doc.getElementById("sheet"));

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
