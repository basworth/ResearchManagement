// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Teaching the matcher which study an email is about.
//
// The matcher's weakness was never vocabulary — it was having no memory. The same journals,
// coordinators and shorthand recur for months, so a correction made once should hold. The risk is
// the mirror image: a hint that matches too eagerly quietly files everything under one study, and
// nobody notices because each individual suggestion looks plausible.
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

const study = (id, title, nick, extra) => ({
  id, kind: "study", updated_at: now,
  data: Object.assign({ id, title, nickname: nick, phase: "Manuscript",
    design: "Retrospective (Non-Consented)", pi: "Adam Yanke", team: [], abstracts: [], docs: [],
    milestones: [], meetingNotes: [], authors: [], noteEntries: [], decision: "" }, extra || {})
});

function boot(extraItems) {
  const items = [
    { id: ME, kind: "profile", updated_at: now,
      data: { id: ME, name: "Adam Yanke", email: "adam.yanke@rushortho.com", position: "Clinician",
              admin: true, reportsTo: "", alertEmail: "", linkedTo: "", alertEmailAsked: true, degreesAsked: true } },
    study(S1, "The MPFL Saddle Point: radiographic landmark for femoral tunnel placement", "Saddle Point MPFL",
      { irb: "ORA-24-0117", journalTrackingId: "AJSM-26-0829" }),
    study(S2, "Regenerative Potential of Fetal Chondrocytes", "Sheep Study", { irb: "ORA-25-0042" }),
    { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
      data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} } }
  ].concat(extraItems || []);
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, pending: [], active: [] }) });
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
async function settings(dom) {
  const { window } = dom;
  await wait(600);
  window.eval(`currentUser = { id: ${JSON.stringify(ME)}, email: "adam.yanke@rushortho.com" }; syncOnline = true;`);
  window.document.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
  await wait(60);
  window.eval(`tab = "settings"; render();`);
  await wait(350);
  return window;
}
const read = (win, text, subject) => JSON.parse(win.eval(`JSON.stringify(readEmail(${JSON.stringify(text)}, ${JSON.stringify(subject || "")}))`));
const suggestions = (win) => JSON.parse(win.eval("JSON.stringify(state.suggestions || [])"));
const hints = (win) => JSON.parse(win.eval("JSON.stringify(state.matchHints || [])"));
const studyOf = (win, id) => JSON.parse(win.eval(`JSON.stringify(studyById(${JSON.stringify(id)}))`));
const toastText = (win) => win.document.getElementById("toast").textContent;
const mainText = (win) => win.document.getElementById("main").textContent;

(async () => {
  console.log("\n-- Acronyms and word endings, before any teaching --");
  {
    const dom = boot();
    const win = await settings(dom);
    check("Plural matches singular: 'chondrocytes' finds the chondrocyte study",
      (read(win, "An update on the fetal chondrocytes work for the sheep.").study || {}).id === S2,
      read(win, "An update on the fetal chondrocytes work for the sheep.").basis);
    check("The MPFL acronym reaches 'medial patellofemoral ligament'",
      (read(win, "Quick question on the MPFL saddle point paper.").study || {}).id === S1,
      read(win, "Quick question on the MPFL saddle point paper.").basis);
    check("...and it still refuses on boilerplate",
      read(win, "This study of patient outcomes following surgical treatment.").study === null);
    dom.window.close();
  }

  console.log("\n-- Teaching it when it matched nothing --");
  {
    const dom = boot();
    const win = await settings(dom);
    const EMAIL = `From: editor@ortho-journal.org
Subject: Your paper on the kneecap tracking landmark

We have reviewed your submission. The reviewers recommend major revision.`;
    win.eval(`ingestEmail(${JSON.stringify(EMAIL)}, "Your paper on the kneecap tracking landmark", "paste", "editor@ortho-journal.org"); render();`);
    await wait(300);
    let g = suggestions(win)[0];
    check("It genuinely can't place it", !g.studyId, g.basis);
    check("The card asks which study it is", /Which study is it/i.test(mainText(win)), mainText(win).slice(0, 600));
    check("...with a picker", !!win.document.querySelector("[data-sugg-teach]"));

    win.eval(`teachSuggestionStudy(${JSON.stringify(g.id)}, ${JSON.stringify(S1)});`);
    await wait(300);
    g = suggestions(win).find(x => x.id === g.id);
    check("It's now filed under the right study", g.studyId === S1, g.studyId);
    check("...and re-read, so the decision is proposed", g.changes.some(c => c.field === "decision" && c.to === "Major revision"), g.changes);
    // No note: the email maps onto a real field, and a note is only the fallback for mail that
    // doesn't. This changed deliberately — every forward used to leave a duplicate note behind.
    check("...and no note, because the decision says it better", !g.applied.some(a => a.field === "addNote")
      && !g.changes.some(c => c.field === "addNote"), g.changes);
    check("It says it learned", /Learned/i.test(toastText(win)), toastText(win));
    check("A hint was recorded", hints(win).length === 1, hints(win));
    check("...remembering the sender", hints(win)[0].sender === "editor@ortho-journal.org", hints(win)[0]);
    check("...and who taught it", hints(win)[0].taughtBy === "Adam Yanke");
    dom.window.close();
  }

  console.log("\n-- And the next email from them matches on its own --");
  {
    const dom = boot([{ id: "h1", kind: "matchHint", updated_at: now,
      data: { id: "h1", studyId: S1, sender: "editor@ortho-journal.org", words: ["kneecap", "tracking", "landmark"], taughtBy: "Adam Yanke" } }]);
    const win = await settings(dom);
    const r = read(win, "From: editor@ortho-journal.org\nSubject: Follow-up\n\nWe are pleased to accept your manuscript.");
    check("Matched from the sender alone", r.study && r.study.id === S1, r.basis);
    check("...and says it was taught", /you taught it/.test(r.basis), r.basis);
    check("...then reads the decision as usual", r.changes.some(c => c.field === "decision" && c.to === "Accepted"), r.changes);
    dom.window.close();
  }

  console.log("\n-- Remembered words work too, but two are needed, not one --");
  {
    const dom = boot([{ id: "h2", kind: "matchHint", updated_at: now,
      data: { id: "h2", studyId: S2, sender: "", words: ["lambing", "abattoir", "vendor"], taughtBy: "Carla Edwards" } }]);
    const win = await settings(dom);
    check("Two remembered words match", (read(win, "The abattoir confirmed the vendor slot.").study || {}).id === S2,
      read(win, "The abattoir confirmed the vendor slot.").basis);
    check("One alone does not — that's how a hint starts matching everything",
      read(win, "The vendor sent an invoice.").study === null,
      read(win, "The vendor sent an invoice.").basis);
    dom.window.close();
  }

  console.log("\n-- A correction outranks the rules' own guess --");
  {
    // The text names S1's tracking ID, but someone has taught it that this sender means S2.
    const dom = boot([{ id: "h3", kind: "matchHint", updated_at: now,
      data: { id: "h3", studyId: S2, sender: "coordinator@rushortho.com", words: [], taughtBy: "Adam Yanke" } }]);
    const win = await settings(dom);
    const r = read(win, "From: coordinator@rushortho.com\n\nNotes on AJSM-26-0829 and the sheep work.");
    check("What a person said wins", r.study && r.study.id === S2, r.basis);
    check("...and the card says why", /you taught it/.test(r.basis), r.basis);
    dom.window.close();
  }

  console.log("\n-- Correcting a match it got WRONG --");
  {
    const dom = boot();
    const win = await settings(dom);
    win.eval(`ingestEmail("Notes about the MPFL saddle point work.", "Update", "paste", "someone@rushortho.com"); render();`);
    await wait(300);
    let g = suggestions(win)[0];
    check("It matched the saddle study", g.studyId === S1, g.basis);
    const notesBefore = (studyOf(win, S1).noteEntries || []).length;
    win.eval(`teachSuggestionStudy(${JSON.stringify(g.id)}, ${JSON.stringify(S2)});`);
    await wait(300);
    g = suggestions(win).find(x => x.id === g.id);
    check("Re-filed under the study you picked", g.studyId === S2, g.studyId);
    check("It says it re-filed, not just filed", /re-filed/i.test(toastText(win)), toastText(win));
    // The note it had already applied to the wrong study is NOT silently removed — notes are a log.
    check("The note already written stays where it was written",
      (studyOf(win, S1).noteEntries || []).length === notesBefore, notesBefore);
    check("...and isn't written twice to the new one",
      (studyOf(win, S2).noteEntries || []).length <= 1, (studyOf(win, S2).noteEntries || []).length);
    dom.window.close();
  }

  console.log("\n-- You can see what it has learned, and undo it --");
  {
    const dom = boot([{ id: "h4", kind: "matchHint", updated_at: now,
      data: { id: "h4", studyId: S1, sender: "editor@ortho-journal.org", words: ["kneecap"], taughtBy: "Carla Edwards" } }]);
    const win = await settings(dom);
    const t = mainText(win);
    check("The list is on screen", /WHAT IT HAS LEARNED/i.test(t), t.slice(0, 400));
    check("...naming the study", /Saddle Point MPFL/.test(t));
    check("...the sender it remembers", /editor@ortho-journal\.org/.test(t));
    check("...and who taught it", /Carla Edwards/.test(t));
    check("...warning that a wrong one keeps being wrong", /keep being wrong/i.test(t));
    const btn = win.document.querySelector("[data-hint-forget]");
    check("There's a Forget", !!btn);
    btn.click();
    await wait(300);
    check("It's gone", hints(win).length === 0);
    check("...and stops matching", read(win, "From: editor@ortho-journal.org\n\nAnything.").study === null);
    check("...and says so", /Forgotten/i.test(toastText(win)), toastText(win));
    dom.window.close();
  }

  console.log("\n-- A hint pointing at a deleted study doesn't break anything --");
  {
    const dom = boot([{ id: "h5", kind: "matchHint", updated_at: now,
      data: { id: "h5", studyId: "no-such-study", sender: "ghost@rushortho.com", words: [], taughtBy: "Adam Yanke" } }]);
    const win = await settings(dom);
    const r = read(win, "From: ghost@rushortho.com\n\nSomething about AJSM-26-0829.");
    check("It falls through to the real rules", r.study && r.study.id === S1, r.basis);
    check("...matching on the tracking ID", /tracking ID/.test(r.basis), r.basis);
    check("The list says the study is gone rather than showing a blank",
      /no longer exists/.test(mainText(win)), mainText(win).slice(0, 400));
    dom.window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", (e && e.stack) ? e.stack : e); process.exit(1); });
