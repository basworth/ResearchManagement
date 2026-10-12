// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Editing a study note in place.
//
// Notes could be added, archived and deleted, but not changed. Fixing a typo meant deleting the
// note and retyping it — which loses its date and, if it had been archived and restored, its
// history. A note is usually one sentence, so this edits inline rather than in a sheet.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ME = "11111111-1111-1111-1111-111111111111";
const S1 = "aaaaaaaa-0000-0000-0000-000000000001";
const S2 = "aaaaaaaa-0000-0000-0000-000000000002";

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

function boot() {
  const items = [
    { id: ME, kind: "profile", updated_at: now,
      data: { id: ME, name: "Adam Yanke", email: "adam.yanke@rushortho.com", position: "Clinician",
              admin: true, reportsTo: "", alertEmail: "", linkedTo: "", alertEmailAsked: true, degreesAsked: true } },
    { id: S1, kind: "study", updated_at: now,
      data: { id: S1, title: "Aspiration Prior to Injection Study for OA", nickname: "Aspirate Inject OA",
        phase: "Concept", design: "Prospective (Consented)", pi: "Adam Yanke", team: [], abstracts: [],
        docs: [], milestones: [], meetingNotes: [], authors: [],
        noteEntries: [
          { id: "n1", text: "Data collection and statistical analysis section of protocl need to be completed", date: "2026-09-28", archivedOn: "" },
          { id: "n2", text: "Second live note", date: "2026-09-20", archivedOn: "" },
          { id: "n3", text: "An archived thought", date: "2026-08-01", archivedOn: "2026-09-01" }
        ] } },
    { id: S2, kind: "study", updated_at: now,
      data: { id: S2, title: "Cartilage thickness", nickname: "Cartilage", phase: "Analysis",
        design: "Basic Science", pi: "Adam Yanke", team: [], abstracts: [], docs: [], milestones: [],
        meetingNotes: [], authors: [], noteEntries: [{ id: "m1", text: "Other study note", date: "2026-09-10", archivedOn: "" }] } },
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

async function openStudy(dom, id) {
  const { window } = dom;
  await wait(600);
  window.eval(`currentUser = { id: ${JSON.stringify(ME)}, email: "adam.yanke@rushortho.com" }; syncOnline = true;`);
  window.document.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
  await wait(60);
  window.eval(`tab = "studies"; openStudy(${JSON.stringify(id || S1)}); studySectionState["notes"] = true; render();`);
  await wait(250);
  return window;
}
const notes = (win, id) => JSON.parse(win.eval(`JSON.stringify(studyById(${JSON.stringify(id || S1)}).noteEntries)`));
const note = (win, nid, sid) => notes(win, sid).find(n => n.id === nid);
const q = (win, sel) => win.document.querySelector(sel);
const toastText = (win) => win.document.getElementById("toast").textContent;

(async () => {
  console.log("\n-- There's a way in --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    check("Each note has an Edit", win.document.querySelectorAll('[data-note-open="n1"]').length >= 1);
    check("...and the text itself opens it, which is where you'd tap",
      !!q(win, 'div[data-note-open="n1"]'));
    check("Archive is still there", !!q(win, '[data-note-arch="n1"]'));
    check("Delete is still there", !!q(win, '[data-note-del="n1"]'));
    dom.window.close();
  }

  console.log("\n-- Editing one --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    q(win, 'div[data-note-open="n1"]').click();
    await wait(250);
    const box = q(win, '[data-note-edit-text="n1"]');
    check("It opens an editor", !!box);
    check("...prefilled with the note", /protocl need to be completed/.test(box.value), box.value);
    check("...and the date is editable too", q(win, '[data-note-edit-date="n1"]').value === "2026-09-28");
    check("Only that one is open", !q(win, '[data-note-edit-text="n2"]'));
    check("The other note still reads normally", !!q(win, 'div[data-note-open="n2"]'));
    box.value = "Data collection and statistical analysis section of protocol need to be completed";
    q(win, '[data-note-edit-save="n1"]').click();
    await wait(300);
    check("The typo is fixed", /protocol need/.test(note(win, "n1").text), note(win, "n1").text);
    check("The date is untouched", note(win, "n1").date === "2026-09-28");
    check("It keeps its id", !!note(win, "n1"));
    check("Still three notes — nothing was destroyed to fix it", notes(win).length === 3);
    check("The other note is untouched", note(win, "n2").text === "Second live note");
    check("The editor closed", !q(win, '[data-note-edit-text="n1"]'));
    check("It says so", /updated/i.test(toastText(win)), toastText(win));
    dom.window.close();
  }

  console.log("\n-- The date can be corrected --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    q(win, 'div[data-note-open="n1"]').click();
    await wait(250);
    q(win, '[data-note-edit-date="n1"]').value = "2026-09-25";
    q(win, '[data-note-edit-save="n1"]').click();
    await wait(300);
    check("A note written up late can carry the date it's about", note(win, "n1").date === "2026-09-25",
      note(win, "n1").date);
    check("...and the text is unchanged", /protocl/.test(note(win, "n1").text));
    dom.window.close();
  }

  console.log("\n-- Cancelling changes nothing --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    q(win, 'div[data-note-open="n1"]').click();
    await wait(250);
    q(win, '[data-note-edit-text="n1"]').value = "something else entirely";
    q(win, '[data-note-edit-cancel="n1"]').click();
    await wait(300);
    check("The note is as it was", /protocl need to be completed/.test(note(win, "n1").text), note(win, "n1").text);
    check("The editor closed", !q(win, '[data-note-edit-text="n1"]'));
    // Reopening must not resurrect the abandoned text via the draft-preservation feature.
    q(win, 'div[data-note-open="n1"]').click();
    await wait(250);
    check("Reopening shows the saved note, not the abandoned edit",
      !/something else entirely/.test(q(win, '[data-note-edit-text="n1"]').value),
      q(win, '[data-note-edit-text="n1"]').value);
    dom.window.close();
  }

  console.log("\n-- An empty note is refused, not silently deleted --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    q(win, 'div[data-note-open="n1"]').click();
    await wait(250);
    q(win, '[data-note-edit-text="n1"]').value = "   ";
    q(win, '[data-note-edit-save="n1"]').click();
    await wait(300);
    check("The note survives", /protocl/.test(note(win, "n1").text));
    check("The editor stays open", !!q(win, '[data-note-edit-text="n1"]'));
    check("...and it points at the right tool", /can't be empty/i.test(toastText(win)), toastText(win));
    check("...naming delete as the deliberate act", /delete/i.test(toastText(win)));
    dom.window.close();
  }

  console.log("\n-- Archived notes can be fixed too --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    // Open the archive group holding n3.
    win.eval(`openNoteArchives["2026-09-01"] = true; render();`);
    await wait(250);
    check("The archived note is reachable", !!q(win, 'div[data-note-open="n3"]'));
    q(win, 'div[data-note-open="n3"]').click();
    await wait(250);
    q(win, '[data-note-edit-text="n3"]').value = "An archived thought, corrected";
    q(win, '[data-note-edit-save="n3"]').click();
    await wait(300);
    check("It was edited", note(win, "n3").text === "An archived thought, corrected");
    check("...and is still archived", note(win, "n3").archivedOn === "2026-09-01", note(win, "n3").archivedOn);
    dom.window.close();
  }

  console.log("\n-- Half-typed edits survive a re-render --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    q(win, 'div[data-note-open="n1"]').click();
    await wait(250);
    q(win, '[data-note-edit-text="n1"]').value = "half a thought about the protoc";
    // What a teammate's change arriving over sync does.
    win.eval("render();");
    await wait(250);
    check("The editor is still open", !!q(win, '[data-note-edit-text="n1"]'));
    check("...with the half-typed text still there",
      q(win, '[data-note-edit-text="n1"]').value === "half a thought about the protoc",
      q(win, '[data-note-edit-text="n1"]').value);
    dom.window.close();
  }

  console.log("\n-- Opening another study closes the editor --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    q(win, 'div[data-note-open="n1"]').click();
    await wait(250);
    check("Editing", win.eval("editingNoteId") === "n1");
    win.eval(`openStudy(${JSON.stringify(S2)}); studySectionState["notes"] = true; render();`);
    await wait(300);
    check("...and not still editing a note from the previous study", win.eval("editingNoteId") === "",
      win.eval("editingNoteId"));
    check("The other study's note reads normally", !!q(win, 'div[data-note-open="m1"]'));
    dom.window.close();
  }

  console.log("\n-- Offline, editing is blocked like every other write --");
  {
    const dom = boot();
    const win = await openStudy(dom);
    win.eval("syncOnline = false;");
    q(win, 'div[data-note-open="n1"]').click();
    await wait(250);
    check("No editor opens", !q(win, '[data-note-edit-text="n1"]'));
    check("...and it says why", /offline|connect/i.test(toastText(win)), toastText(win));
    dom.window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", (e && e.stack) ? e.stack : e); process.exit(1); });
