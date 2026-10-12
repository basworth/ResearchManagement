// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Editing a meeting-notes entry.
//
// Both lists — the per-study one and the team-wide tab — could only add and delete. Fixing a
// misspelt label or a wrong link meant destroying the entry and retyping it, which is the one
// thing this app is not supposed to make people do. Editing keeps the entry and its id.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ME = "11111111-1111-1111-1111-111111111111";
const STUDY = "aaaaaaaa-0000-0000-0000-000000000001";
const NOTE = "note-0000-0000-0000-000000000001";
const TEAMNOTE = "team-0000-0000-0000-000000000001";

const OLD_LINK = "https://docs.google.com/document/d/OLDOLDOLD/edit";
const NEW_LINK = "https://docs.google.com/document/d/NEWNEWNEW/edit";

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
    { id: STUDY, kind: "study", updated_at: now,
      data: { id: STUDY, title: "Meniscal repair outcomes", nickname: "Meniscus", phase: "Data Collection",
              design: "Retrospective (Non-Consented)", pi: "Adam Yanke", team: [], abstracts: [], docs: [],
              milestones: [], authors: [],
              meetingNotes: [
                { id: NOTE, label: "Weekly Reserch Meeting 7/29", date: "2026-07-29", link: OLD_LINK },
                { id: "note-b", label: "Kickoff", date: "2026-06-01", link: "https://example.com/kickoff" }
              ] } },
    { id: TEAMNOTE, kind: "teamNote", updated_at: now,
      data: { id: TEAMNOTE, label: "Weekly Research Meting", date: "2026-09-21", link: OLD_LINK } },
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

async function signedIn(dom) {
  const { window } = dom;
  await wait(600);
  window.eval(`currentUser = { id: ${JSON.stringify(ME)}, email: "adam.yanke@rushortho.com" }; syncOnline = true;`);
  window.document.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
  await wait(60);
  return window;
}
async function openStudyNotes(dom) {
  const win = await signedIn(dom);
  win.eval(`tab = "studies"; openStudy("${STUDY}"); studySectionState["meetingNotes"] = true; render();`);
  await wait(250);
  return win;
}
async function openTeamNotes(dom) {
  const win = await signedIn(dom);
  win.eval(`tab = "notes"; render();`);
  await wait(250);
  return win;
}
const studyNotes = (win) => JSON.parse(win.eval(`JSON.stringify(studyById(${JSON.stringify(STUDY)}).meetingNotes)`));
const teamNotes = (win) => JSON.parse(win.eval(`JSON.stringify(state.teamNotes)`));
const toastText = (doc) => doc.getElementById("toast").textContent;
const fill = (doc, id, v) => { doc.getElementById(id).value = v; };

(async () => {
  console.log("\n-- A study's meeting notes can be corrected --");
  {
    const dom = boot();
    const win = await openStudyNotes(dom);
    const doc = win.document;
    const btn = doc.querySelector(`[data-mnote-edit="${NOTE}"]`);
    check("There's an Edit next to each entry", !!btn);
    check("...one per entry", doc.querySelectorAll("[data-mnote-edit]").length === 2,
      doc.querySelectorAll("[data-mnote-edit]").length);
    check("Delete is still there too", !!doc.querySelector(`[data-mnote-del="${NOTE}"]`));
    btn.click();
    await wait(250);
    check("The sheet opens", !!doc.getElementById("sheet"));
    check("...pre-filled with the current label", doc.getElementById("mn-edit-label").value === "Weekly Reserch Meeting 7/29",
      doc.getElementById("mn-edit-label").value);
    check("...the current date", doc.getElementById("mn-edit-date").value === "2026-07-29");
    check("...and the current link", doc.getElementById("mn-edit-link").value === OLD_LINK);
    dom.window.close();
  }

  console.log("\n-- Saving changes only what you changed --");
  {
    const dom = boot();
    const win = await openStudyNotes(dom);
    const doc = win.document;
    doc.querySelector(`[data-mnote-edit="${NOTE}"]`).click();
    await wait(250);
    fill(doc, "mn-edit-label", "Weekly Research Meeting 7/29");
    doc.getElementById("sheet-save").click();
    await wait(300);
    const notes = studyNotes(win);
    const n = notes.find(x => x.id === NOTE);
    check("The typo is fixed", n.label === "Weekly Research Meeting 7/29", n.label);
    check("The date is untouched", n.date === "2026-07-29", n.date);
    check("The link is untouched", n.link === OLD_LINK, n.link);
    check("It keeps its id, so nothing pointing at it breaks", n.id === NOTE);
    check("Still two entries — nothing was destroyed to fix it", notes.length === 2, notes.length);
    check("The other entry is untouched",
      JSON.stringify(notes.find(x => x.id === "note-b")) === JSON.stringify({ id: "note-b", label: "Kickoff", date: "2026-06-01", link: "https://example.com/kickoff" }),
      notes.find(x => x.id === "note-b"));
    check("It says so", /updated/i.test(toastText(doc)), toastText(doc));
    await wait(400);   // closeSheet animates out
    check("The sheet closed", !doc.getElementById("sheet"));
    dom.window.close();
  }

  console.log("\n-- A wrong link can be replaced --");
  {
    const dom = boot();
    const win = await openStudyNotes(dom);
    const doc = win.document;
    doc.querySelector(`[data-mnote-edit="${NOTE}"]`).click();
    await wait(250);
    fill(doc, "mn-edit-link", NEW_LINK);
    doc.getElementById("sheet-save").click();
    await wait(300);
    check("The new link is stored", studyNotes(win).find(x => x.id === NOTE).link === NEW_LINK);
    await wait(150);
    // The row is rebuilt from the study, so Open and Copy must now carry the new URL — a stale
    // Copy button would hand out the wrong document without looking wrong.
    const d2 = win.document;
    check("Open points at the new link",
      !![...d2.querySelectorAll("a[href]")].find(a => a.getAttribute("href") === NEW_LINK));
    check("Copy carries the new link", !!d2.querySelector(`[data-copy-link="${NEW_LINK}"]`));
    check("Nothing still points at the old one", !d2.querySelector(`[data-copy-link="${OLD_LINK}"]`));
    dom.window.close();
  }

  console.log("\n-- The date can be cleared, the link can't --");
  {
    const dom = boot();
    const win = await openStudyNotes(dom);
    const doc = win.document;
    doc.querySelector(`[data-mnote-edit="${NOTE}"]`).click();
    await wait(250);
    fill(doc, "mn-edit-date", "");
    doc.getElementById("sheet-save").click();
    await wait(300);
    check("An undated entry is allowed", studyNotes(win).find(x => x.id === NOTE).date === "");
    dom.window.close();
  }
  {
    const dom = boot();
    const win = await openStudyNotes(dom);
    const doc = win.document;
    doc.querySelector(`[data-mnote-edit="${NOTE}"]`).click();
    await wait(250);
    fill(doc, "mn-edit-link", "   ");
    doc.getElementById("sheet-save").click();
    await wait(300);
    check("An entry pointing at nothing is refused", studyNotes(win).find(x => x.id === NOTE).link === OLD_LINK);
    check("...the sheet stays open rather than closing on a refusal", !!win.document.getElementById("sheet"));
    check("...and says what's wrong", /Paste a link/i.test(toastText(win.document)), toastText(win.document));
    dom.window.close();
  }

  console.log("\n-- Cancelling changes nothing --");
  {
    const dom = boot();
    const win = await openStudyNotes(dom);
    const doc = win.document;
    doc.querySelector(`[data-mnote-edit="${NOTE}"]`).click();
    await wait(250);
    fill(doc, "mn-edit-label", "something else entirely");
    fill(doc, "mn-edit-link", NEW_LINK);
    doc.getElementById("sheet-cancel").click();
    await wait(300);
    const n = studyNotes(win).find(x => x.id === NOTE);
    check("The label is as it was", n.label === "Weekly Reserch Meeting 7/29", n.label);
    check("The link is as it was", n.link === OLD_LINK, n.link);
    dom.window.close();
  }

  console.log("\n-- The team-wide Meeting Notes tab too --");
  {
    const dom = boot();
    const win = await openTeamNotes(dom);
    const doc = win.document;
    const btn = doc.querySelector(`[data-note-edit="${TEAMNOTE}"]`);
    check("There's an Edit there as well", !!btn);
    btn.click();
    await wait(250);
    check("Pre-filled from that note", doc.getElementById("mn-edit-label").value === "Weekly Research Meting");
    fill(doc, "mn-edit-label", "Weekly Research Meeting");
    fill(doc, "mn-edit-date", "2026-09-22");
    doc.getElementById("sheet-save").click();
    await wait(300);
    const t = teamNotes(win).find(x => x.id === TEAMNOTE);
    check("The label is fixed", t.label === "Weekly Research Meeting", t.label);
    check("The date is changed", t.date === "2026-09-22", t.date);
    check("The link is untouched", t.link === OLD_LINK, t.link);
    check("It keeps its id", t.id === TEAMNOTE);
    check("Still one note, not two", teamNotes(win).length === 1, teamNotes(win).length);
    dom.window.close();
  }

  console.log("\n-- Offline, editing is blocked like every other write --");
  {
    const dom = boot();
    const win = await openStudyNotes(dom);
    const doc = win.document;
    win.eval("syncOnline = false;");
    doc.querySelector(`[data-mnote-edit="${NOTE}"]`).click();
    await wait(250);
    check("No edit sheet opens", !doc.getElementById("mn-edit-label"));
    check("...and it says why", /offline|connect/i.test(toastText(doc)), toastText(doc));
    dom.window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
