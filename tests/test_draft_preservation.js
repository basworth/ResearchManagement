// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Half-typed text surviving a re-render.
//
// Every render() rebuilds the page from innerHTML. Anything someone was in the middle of typing
// went with it — and re-renders aren't rare: a teammate's edit arriving over realtime sync
// re-renders the page under you. Type a paragraph of notes, have someone else touch a study,
// and it's gone with nothing to say so.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ME = "11111111-1111-1111-1111-111111111111";
const STUDY = "aaaaaaaa-0000-0000-0000-000000000001";

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

function boot(studyExtra) {
  const items = [
    { id: ME, kind: "profile", updated_at: now,
      data: { id: ME, name: "Adam Yanke", email: "adam.yanke@rushortho.com", position: "Clinician",
              admin: true, reportsTo: "", alertEmail: "", linkedTo: "", alertEmailAsked: true, degreesAsked: true } },
    { id: STUDY, kind: "study", updated_at: now,
      data: Object.assign({ id: STUDY, title: "Meniscal repair outcomes", nickname: "Meniscus",
        phase: "Manuscript", design: "Retrospective (Non-Consented)", pi: "Adam Yanke", team: [],
        milestones: [], meetingNotes: [], authors: [], abstracts: [],
        // Working Documents lists only the types a study holds, so seed one entry in the two
        // slots these scenarios type into. Without them there are no link boxes to type in.
        docSlots: {
          manuscript: [{ id: "seed-m", kind: "link", url: "https://example.com/seed-manuscript", label: "", by: "Adam Yanke", date: "2026-09-01" }],
          abstract:   [{ id: "seed-a", kind: "link", url: "https://example.com/seed-abstract",   label: "", by: "Adam Yanke", date: "2026-09-01" }]
        },
        docs: [],
        journal: "AJSM", decision: "Awaiting decision" }, studyExtra || {}) },
    { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
      data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} } }
  ];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
      win.supabase = { createClient: () => {
        const c = makeMockSupabase({ items });
        c.auth.getSession = async () => ({ data: { session: { access_token: "tok", user: { id: ME, email: "adam.yanke@rushortho.com" } } }, error: null });
        return c;
      } };
    }
  });
  return dom;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

async function openStudy(dom, sections) {
  const { window } = dom;
  await wait(600);
  window.eval(`currentUser = { id: ${JSON.stringify(ME)}, email: "adam.yanke@rushortho.com" }; syncOnline = true;`);
  window.document.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
  await wait(60);
  const open = (sections || ["workingDocs", "manuscript", "abstracts", "meetingNotes", "notes"])
    .map(k => `studySectionState[${JSON.stringify(k)}] = true;`).join(" ");
  window.eval(`tab = "studies"; openStudy("${STUDY}"); ${open} render();`);
  await wait(250);
  return window;
}
const q = (win, sel) => win.document.querySelector(sel);
const slot = (win, key) => JSON.parse(win.eval(`JSON.stringify(studyById(${JSON.stringify(STUDY)}).docSlots[${JSON.stringify(key)}])`));

(async () => {
  console.log("\n-- Typing survives someone else's change arriving --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    const box = q(win, '[data-slot-link="manuscript"]');
    box.value = "https://docs.google.com/document/d/HALFTYPED";
    // What a realtime update does: rebuild the page.
    win.eval("render();");
    await wait(200);
    const after = q(win, '[data-slot-link="manuscript"]');
    check("The text is still there", after.value === "https://docs.google.com/document/d/HALFTYPED", after.value);
    check("...and it's a genuinely new element, so it really was restored", after !== box);
    dom.window.close();
  }

  console.log("\n-- Several fields at once, each keeping its own text --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    q(win, "#mnote-label").value = "Weekly meeting 9/28";
    q(win, '[data-slot-link="abstract"]').value = "https://example.com/abs";
    q(win, "#abs-meeting").value = "AAOS 2027";
    win.eval("render();");
    await wait(200);
    check("The meeting-note label held", q(win, "#mnote-label").value === "Weekly meeting 9/28");
    check("The abstract slot held", q(win, '[data-slot-link="abstract"]').value === "https://example.com/abs");
    check("The abstract meeting held", q(win, "#abs-meeting").value === "AAOS 2027");
    check("...and nothing leaked between them",
      q(win, '[data-slot-link="manuscript"]').value === "", q(win, '[data-slot-link="manuscript"]').value);
    dom.window.close();
  }

  console.log("\n-- The cursor goes back where it was --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    // Meeting Notes auto-collapses on a study that has none, and a collapsed section is hidden,
    // which means focus() is a no-op here (and nobody could be typing in it in the first place).
    // Open it, the way a person would before typing.
    win.eval(`studySectionState["meetingNotes"] = true; render();`);
    const box = q(win, "#mnote-label");
    box.value = "Weekly Research Meeting";
    box.focus();
    box.setSelectionRange(7, 7);   // mid-word, as if fixing a typo
    win.eval("render();");
    await wait(200);
    const after = q(win, "#mnote-label");
    check("The field still has focus", win.document.activeElement === after);
    check("...with the caret where it was, not dumped at the end",
      after.selectionStart === 7 && after.selectionEnd === 7, [after.selectionStart, after.selectionEnd]);
    dom.window.close();
  }

  console.log("\n-- Text that was never touched is left alone --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    check("A saved field shows its saved value", q(win, "#ms-journal").value === "AJSM");
    win.eval("render();");
    await wait(200);
    check("...and still does after a re-render", q(win, "#ms-journal").value === "AJSM");
    dom.window.close();
  }

  console.log("\n-- Submitting clears the draft, so the box doesn't refill --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    q(win, '[data-slot-link="manuscript"]').value = "https://example.com/final";
    q(win, '[data-slot-save="manuscript"]').click();
    await wait(300);
    check("It was filed", slot(win, "manuscript")[0].url === "https://example.com/final", slot(win, "manuscript"));
    check("The box is empty, ready for the next one", q(win, '[data-slot-link="manuscript"]').value === "",
      q(win, '[data-slot-link="manuscript"]').value);
    win.eval("render();");
    await wait(200);
    check("...and stays empty through another re-render", q(win, '[data-slot-link="manuscript"]').value === "");
    dom.window.close();
  }

  console.log("\n-- Adding a meeting note clears its three boxes --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    q(win, "#mnote-label").value = "Kickoff";
    q(win, "#mnote-link").value = "https://example.com/notes";
    q(win, "#mnote-add").click();
    await wait(300);
    check("The note was added", JSON.parse(win.eval(`JSON.stringify(studyById(${JSON.stringify(STUDY)}).meetingNotes)`)).length === 1);
    check("The label box is clear", q(win, "#mnote-label").value === "", q(win, "#mnote-label").value);
    check("The link box is clear", q(win, "#mnote-link").value === "");
    dom.window.close();
  }

  console.log("\n-- Clearing a field back to what was saved isn't a draft --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    const j = q(win, "#ms-journal");
    j.value = "Arthroscopy";
    win.eval("render();");
    await wait(200);
    check("The typed change is held", q(win, "#ms-journal").value === "Arthroscopy");
    q(win, "#ms-journal").value = "AJSM";      // undone by hand, back to the saved value
    win.eval("render();");
    await wait(200);
    check("Undoing it drops the draft rather than pinning the old text",
      q(win, "#ms-journal").value === "AJSM", q(win, "#ms-journal").value);
    dom.window.close();
  }

  console.log("\n-- It's kept for the session, not for ever --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    q(win, "#mnote-label").value = "unsaved thought";
    win.eval("render();");
    await wait(200);
    const stored = win.sessionStorage.getItem("rt-drafts");
    check("Drafts go to sessionStorage, so a reload keeps them", !!stored && /unsaved thought/.test(stored), stored);
    check("...and NOT to localStorage, which would outlive the session on a shared computer",
      !/unsaved thought/.test(win.localStorage.getItem("rt-data") || ""));
    dom.window.close();
  }

  console.log("\n-- A checkbox is not a draft --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    // Ticking something and re-rendering must not be "restored" over the real state.
    win.eval("render();");
    await wait(150);
    const drafts = JSON.parse(win.sessionStorage.getItem("rt-drafts") || "{}");
    check("Nothing checkbox-shaped was captured",
      Object.keys(drafts).every(k => typeof drafts[k].v === "string"), drafts);
    dom.window.close();
  }

  console.log("\n-- A field with no stable identity is skipped, not mis-restored --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    win.eval(`
      const el = document.createElement("input");
      el.type = "text"; el.value = "anonymous";
      document.getElementById("main").appendChild(el);
    `);
    win.eval("render();");
    await wait(200);
    const drafts = JSON.parse(win.sessionStorage.getItem("rt-drafts") || "{}");
    check("It isn't stored under an empty key", !("" in drafts), Object.keys(drafts));
    dom.window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", (e && e.stack) ? e.stack : e); process.exit(1); });
