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

  const studiesBtn = doc.querySelector('button[data-tab="studies"]');

  // --- No identity set yet: show everyone rather than an alarming empty list ---
  studiesBtn.click();
  await wait(50);
  const personSelect = () => doc.getElementById("person-filter");
  const allRowsNoIdentity = doc.querySelectorAll('[data-study]').length;
  console.log("With no identity set, 'Mine' shows all sample studies (graceful fallback):", allRowsNoIdentity > 0);

  // --- Non-admin with an identity that matches nothing -> Mine shows 0, and no Who picker ---
  settingsBtn.click();
  await wait(50);
  const meInput = doc.getElementById("me-name");
  meInput.value = "Zz153Nobody";
  meInput.dispatchEvent(new window.Event("change"));
  await wait(50);

  studiesBtn.click();
  await wait(50);
  console.log("Unmatched identity's 'Mine' filter shows zero studies:", doc.querySelectorAll('[data-study]').length === 0);
  console.log("Non-admin has no Who picker to widen the view:", !personSelect());

  // --- Admin identity: gets the Who picker and can switch to All Projects ---
  settingsBtn.click();
  await wait(50);
  doc.getElementById("me-name").value = "Adam Yanke";
  doc.getElementById("me-name").dispatchEvent(new window.Event("change"));
  await wait(50);
  studiesBtn.click();
  await wait(50);
  console.log("Admin gets the Who picker:", !!personSelect());
  console.log("Person filter resets to 'mine' after identity change:", personSelect().value === "mine");
  console.log("'Mine' option label reflects the entered name:", [...personSelect().options].find(o => o.value === "mine").textContent.includes("Adam Yanke"));

  personSelect().value = "all";
  personSelect().dispatchEvent(new window.Event("change"));
  await wait(50);
  console.log("Switching to 'All Projects' brings studies back:", doc.querySelectorAll('[data-study]').length > 0);

  // --- Now set identity to a real PI from the sample data and confirm 'Mine' filters correctly ---
  settingsBtn.click();
  await wait(50);
  // find a PI name from an actual study via the roster/datalist
  doc.getElementById("me-name").value = "";
  doc.getElementById("me-name").dispatchEvent(new window.Event("change"));
  await wait(50);
  studiesBtn.click();
  await wait(50);
  const anyCard = doc.querySelector('.study-row');
  anyCard.click();
  await wait(50);
  const piText = doc.getElementById("main").innerHTML;
  const piMatch = /<b>PI:<\/b>\s*([^<]+)/.exec(piText);
  const pi = piMatch ? piMatch[1].trim() : null;
  console.log("Found a PI name from sample data:", pi);

  if (pi) {
    settingsBtn.click();
    await wait(50);
    doc.getElementById("me-name").value = pi;
    doc.getElementById("me-name").dispatchEvent(new window.Event("change"));
    await wait(50);
    studiesBtn.click();
    await wait(50);
    const mineCount = doc.querySelectorAll('[data-study]').length;
    console.log("'Mine' filter for a real PI shows at least one study:", mineCount > 0);

    // Verify studyInvolvesPerson correctly excludes studies where they're not PI/team/assignee.
    // (Best-effort: total studies with this filter should be <= total studies overall.)
    personSelect().value = "all";
    personSelect().dispatchEvent(new window.Event("change"));
    await wait(50);
    const allCount = doc.querySelectorAll('[data-study]').length;
    console.log("'Mine' count is <= 'All Projects' count:", mineCount <= allCount, `(mine=${mineCount}, all=${allCount})`);
  }

  // --- Society subscriptions: with an identity set, toggling should persist across a fresh render ---
  settingsBtn.click();
  await wait(50);
  doc.getElementById("me-name").value = "PrefTestUser";
  doc.getElementById("me-name").dispatchEvent(new window.Event("change"));
  await wait(50);
  const firstToggle = doc.querySelector(".sub-toggle");
  const soc = firstToggle.dataset.soc;
  const before = firstToggle.checked;
  firstToggle.click();
  firstToggle.dispatchEvent(new window.Event("change"));
  await wait(50);
  settingsBtn.click(); // re-render settings fresh
  await wait(50);
  const after = doc.querySelector(`.sub-toggle[data-soc="${soc}"]`).checked;
  console.log("Society subscription toggle persists (per-identity) after re-render:", after === !before);

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
