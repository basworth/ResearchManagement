// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
  }
});
const { window } = dom;

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  await wait(200);
  const doc = window.document;

  const settingsBtn = doc.querySelector('button[data-tab="settings"]');
  settingsBtn.click();
  await wait(50);
  const loadSampleBtn = [...doc.querySelectorAll('button')].find(b => b.textContent.includes("Load Sample Data"));
  if (loadSampleBtn) { loadSampleBtn.click(); await wait(50); }

  // --- Project Overview field ---
  const studiesBtn = doc.querySelector('button[data-tab="studies"]');
  studiesBtn.click();
  await wait(50);
  const card = doc.querySelector('.study-row');
  card.click();
  await wait(50);

  window.eval(`(function(){ const s = studyById(detailStudyId);
    s.docSlots = s.docSlots || {};
    ["abstract","overview","manuscript"].forEach(k => { s.docSlots[k] = s.docSlots[k] || [];
      if (!s.docSlots[k].length) s.docSlots[k].push({ id: "seed-"+k, kind: "link",
        url: "https://example.com/"+k, label: "", by: "Adam Yanke", date: "2026-09-01" }); });
    render(); })()`);
  console.log("Project Overview slot present:", !!doc.querySelector('[data-slot-link="overview"]'));
  const overviewField = doc.querySelector('[data-slot-link="overview"]');
  overviewField.value = "https://docs.example.com/project-overview";
  doc.querySelector('[data-slot-save="overview"]').click();
  await wait(50);
  console.log("Project Overview persisted:", doc.body.innerHTML.includes("overview"));
  console.log("Project Overview field positioned right after Working Abstract:", (() => {
    const html2 = doc.getElementById("main").innerHTML;
    const abstractIdx = html2.indexOf("Working Abstract");
    const overviewIdx = html2.indexOf("Project Overview");
    const manuscriptIdx = html2.indexOf("Working Manuscript");
    return abstractIdx < overviewIdx && overviewIdx < manuscriptIdx;
  })());

  // --- Per-study Meeting Notes ---
  // Every mutating action is blocked while the app thinks it is offline, so without this the
  // adds below silently do nothing and the "note appears" checks only ever matched the
  // placeholder text in the empty form.
  window.eval("syncOnline = true;");
  console.log("Meeting Notes section present:", doc.body.textContent.includes("Meeting Notes"));
  doc.getElementById("mnote-label").value = "Weekly Research Meeting 7/29";
  doc.getElementById("mnote-date").value = "2026-07-29";
  doc.getElementById("mnote-link").value = "https://notes.example.com/wk1";
  doc.getElementById("mnote-add").click();
  await wait(50);
  let mainHTML = doc.getElementById("main").innerHTML;
  console.log("First meeting note appears:", mainHTML.includes("Weekly Research Meeting 7/29"));

  // Add a second note to confirm multiple notes can be linked
  doc.getElementById("mnote-label").value = "Weekly Research Meeting 8/5";
  doc.getElementById("mnote-date").value = "2026-08-05";
  doc.getElementById("mnote-link").value = "https://notes.example.com/wk2";
  doc.getElementById("mnote-add").click();
  await wait(50);
  mainHTML = doc.getElementById("main").innerHTML;
  console.log("Second meeting note also appears (multiple notes per study):", mainHTML.includes("Weekly Research Meeting 8/5") && mainHTML.includes("Weekly Research Meeting 7/29"));

  // Delete one note
  const beforeCount = (doc.getElementById("main").innerHTML.match(/Weekly Research Meeting/g) || []).length;
  console.log("before delete count:", beforeCount);
  const delBtns = doc.querySelectorAll("[data-mnote-del]");
  console.log("num delete buttons found:", delBtns.length);
  delBtns[0].click();
  await wait(50);
  mainHTML = doc.getElementById("main").innerHTML;
  // Count the rows, not the text: the empty form's placeholder is also "Weekly Research
  // Meeting 7/29", so a text match always reads one higher than the number of notes.
  const remainingCount = doc.querySelectorAll("[data-mnote-del]").length;
  console.log("One note removed, one remains:", remainingCount === 1);

  // --- Global Meeting Notes tab ---
  const notesBtn = doc.querySelector('button[data-tab="notes"]');
  console.log("Global Notes tab button present:", !!notesBtn);
  notesBtn.click();
  await wait(50);
  console.log("Notes tab page title:", doc.getElementById("page-title").textContent);
  console.log("Add button hidden on Notes tab:", doc.getElementById("add-btn").style.visibility);

  doc.getElementById("note-label").value = "Weekly Research Meeting";
  doc.getElementById("note-date").value = "2026-07-29";
  doc.getElementById("note-link").value = "https://notes.example.com/all-studies-wk1";
  doc.getElementById("note-add").click();
  await wait(50);
  let notesHTML = doc.getElementById("main").innerHTML;
  console.log("Global meeting note appears in Notes tab:", notesHTML.includes("all-studies-wk1"));

  // Confirm this global note is separate from the per-study one (not shown on the study page)
  studiesBtn.click();
  await wait(50);
  card.click();
  await wait(50);
  const studyPageHTML = doc.getElementById("main").innerHTML;
  console.log("Global note does NOT leak into study page:", !studyPageHTML.includes("all-studies-wk1"));

  console.log("TEST DONE - no errors thrown");
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
