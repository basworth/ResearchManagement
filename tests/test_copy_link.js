// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Working-document links are Google Docs and SharePoint URLs, and the browser you happen to be
// holding is often signed into the wrong account. Open stays a one-tap anchor; Copy sits next to
// it so the URL can be pasted into whichever browser or profile is signed in — far better than
// trying to select a long URL out of a text box on a phone.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ME = "11111111-1111-1111-1111-111111111111";
const STUDY = "aaaaaaaa-0000-0000-0000-000000000001";

const MS_LINK = "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit";
const AB_LINK = "https://rushortho.sharepoint.com/:w:/r/sites/research/abstract.docx?web=1";
const NOTE_LINK = "https://docs.google.com/document/d/9ZyXwVuTsRqPoNmLkJiHgFe/edit";

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

// `clipboard` decides what the environment offers: "modern" (navigator.clipboard resolves),
// "reject" (present but throws — old iOS / insecure context), or "absent" (no API at all).
function boot(clipboard) {
  const written = [];
  const items = [
    { id: ME, kind: "profile", updated_at: now,
      data: { id: ME, name: "Adam Yanke", email: "adam.yanke@rushortho.com", position: "Clinician",
              admin: true, reportsTo: "", alertEmail: "", linkedTo: "", alertEmailAsked: true, degreesAsked: true } },
    { id: STUDY, kind: "study", updated_at: now,
      data: { id: STUDY, title: "Meniscal repair outcomes", phase: "Manuscript", pi: "Adam Yanke",
              team: [], design: "Retrospective", abstracts: [], docs: [], milestones: [], authors: [],
              workingManuscriptLink: MS_LINK, workingAbstractLink: AB_LINK,
              meetingNotes: [{ id: "n1", label: "Kickoff", date: "2026-08-01", link: NOTE_LINK, text: "notes" }] } },
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
      if (clipboard === "modern") {
        win.navigator.clipboard = { writeText: async (t) => { written.push(t); } };
      } else if (clipboard === "reject") {
        win.navigator.clipboard = { writeText: async () => { throw new Error("NotAllowedError"); } };
      }
      // "absent": leave navigator.clipboard undefined.
      // jsdom has no execCommand; define it so the fallback path is exercised deliberately.
      win.document.execCommand = (cmd) => {
        if (cmd !== "copy") return false;
        const el = win.document.activeElement;
        if (el && el.tagName === "TEXTAREA") { written.push(el.value); return true; }
        return false;
      };
      win.supabase = { createClient: () => {
        const c = makeMockSupabase({ items });
        c.auth.getSession = async () => ({ data: { session: { access_token: "tok", user: { id: ME, email: "adam.yanke@rushortho.com" } } }, error: null });
        return c;
      } };
    }
  });
  return { dom, written };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

async function openStudy(dom) {
  const { window } = dom;
  await wait(600);
  window.eval(`currentUser = { id: ${JSON.stringify(ME)}, email: "adam.yanke@rushortho.com" }; syncOnline = true;`);
  window.document.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
  await wait(60);
  window.eval(`tab = "studies"; openStudy("${STUDY}"); ["workingDocs","meetingNotes"].forEach(function(id){ studySectionState[id] = true; }); render();`);
  await wait(250);
  return window.document;
}
const copyBtnFor = (doc, url) => [...doc.querySelectorAll("[data-copy-link]")].find(b => b.dataset.copyLink === url);
const toastText = (doc) => doc.getElementById("toast").textContent;

(async () => {
  console.log("\n-- Both options are offered, side by side --");
  {
    const { dom } = boot("modern");
    const doc = await openStudy(dom);
    const anchor = [...doc.querySelectorAll("a[href]")].find(a => a.getAttribute("href") === MS_LINK);
    check("Open is still a real anchor", !!anchor, anchor && anchor.textContent);
    check("...opening in a new tab", anchor && anchor.getAttribute("target") === "_blank");
    check("...with noopener kept", anchor && /noopener/.test(anchor.getAttribute("rel") || ""));
    check("A Copy button sits alongside it", !!copyBtnFor(doc, MS_LINK));
    check("Copy is a button, not a link", copyBtnFor(doc, MS_LINK).tagName === "BUTTON");
    check("...and type=button, so it can't submit anything",
      copyBtnFor(doc, MS_LINK).getAttribute("type") === "button");
    check("Every filled link field gets one", !!copyBtnFor(doc, AB_LINK));
    check("Meeting-notes links get one too", !!copyBtnFor(doc, NOTE_LINK));
    dom.window.close();
  }

  console.log("\n-- Empty fields offer neither --");
  {
    const { dom } = boot("modern");
    const doc = await openStudy(dom);
    // Only two of the six working-doc links are filled in this fixture.
    const btns = [...doc.querySelectorAll('[data-sec-body="workingDocs"] [data-copy-link]')];
    check("Exactly the two filled fields have Copy", btns.length === 2, btns.map(b => b.dataset.copyLabel));
    check("No Copy button carries an empty URL", btns.every(b => (b.dataset.copyLink || "").length > 10));
    dom.window.close();
  }

  console.log("\n-- Copying, on a modern browser --");
  {
    const { dom, written } = boot("modern");
    const doc = await openStudy(dom);
    copyBtnFor(doc, MS_LINK).click();
    await wait(200);
    check("The exact URL is written to the clipboard", written[written.length - 1] === MS_LINK, written);
    check("It says so", /copied/i.test(toastText(doc)), toastText(doc));
    check("...naming which link", /Working Manuscript/i.test(toastText(doc)), toastText(doc));
    check("...and why you'd want it", /signed into/i.test(toastText(doc)), toastText(doc));
    dom.window.close();
  }

  console.log("\n-- A SharePoint URL with query characters survives intact --");
  {
    const { dom, written } = boot("modern");
    const doc = await openStudy(dom);
    copyBtnFor(doc, AB_LINK).click();
    await wait(200);
    check("Copied byte for byte", written[written.length - 1] === AB_LINK, written[written.length - 1]);
    check("The ? and = weren't escaped", (written[written.length - 1] || "").indexOf("?web=1") > 0);
    dom.window.close();
  }

  console.log("\n-- Old iOS: clipboard API present but refuses --");
  {
    const { dom, written } = boot("reject");
    const doc = await openStudy(dom);
    copyBtnFor(doc, MS_LINK).click();
    await wait(200);
    check("It falls back and still copies", written[written.length - 1] === MS_LINK, written);
    check("...and reports success, because it did succeed", /copied/i.test(toastText(doc)), toastText(doc));
    dom.window.close();
  }

  console.log("\n-- Opened as a local file: no clipboard API at all --");
  {
    const { dom, written } = boot("absent");
    const doc = await openStudy(dom);
    copyBtnFor(doc, MS_LINK).click();
    await wait(200);
    check("The legacy path handles it", written[written.length - 1] === MS_LINK, written);
    dom.window.close();
  }

  console.log("\n-- When copying genuinely fails, it doesn't pretend --");
  {
    const { dom } = boot("absent");
    const doc = await openStudy(dom);
    // Break the fallback too, so nothing can copy.
    dom.window.document.execCommand = () => false;
    copyBtnFor(doc, MS_LINK).click();
    await wait(200);
    const t = toastText(doc);
    check("It admits it couldn't", /couldn't reach the clipboard/i.test(t), t);
    check("...and does NOT claim success", !/copied/i.test(t), t);
    check("...offering a manual route instead", /⌘C|long-press|address bar/i.test(t), t);
    // A document row holds no text input of its own, so the fallback drops the URL into the
    // slot's own "paste a link" box and selects it there — one keystroke away rather than a
    // dead end. The claim in the toast and what actually happened have to agree.
    const input = doc.querySelector('[data-slot-link="manuscript"]');
    const selected = input && input.value === MS_LINK && input.selectionStart === 0 && input.selectionEnd === MS_LINK.length;
    if (/selected/i.test(t)) {
      check("It says the link is selected, and it really is", selected,
        input && [input.value, input.selectionStart, input.selectionEnd]);
    } else {
      check("It doesn't claim the link is selected when it isn't", !selected);
      check("...and points somewhere that does work", /address bar/i.test(t), t);
    }
    dom.window.close();
  }

  console.log("\n-- Clicking Copy doesn't navigate --");
  {
    const { dom } = boot("modern");
    const doc = await openStudy(dom);
    // Listen on document, registered AFTER the app's own document-level handler, so this runs
    // after it. A listener on the button itself fires during the target phase — before the
    // document handler has had a chance to preventDefault — and would always look unprevented.
    let prevented = null;
    dom.window.document.addEventListener("click", (ev) => { prevented = ev.defaultPrevented; });
    copyBtnFor(doc, MS_LINK).click();
    await wait(150);
    check("The default action is prevented", prevented === true, prevented);
    check("Still on the study page", !!doc.querySelector('[data-sec-body="workingDocs"]'));
    dom.window.close();
  }

  console.log("\n-- The helper itself --");
  {
    const { dom, written } = boot("modern");
    const { window } = dom;
    await openStudy(dom);
    check("Empty input copies nothing and reports false",
      (await window.eval('copyToClipboard("")')) === false);
    check("null is handled", (await window.eval('copyToClipboard(null)')) === false);
    check("Nothing was written for either", written.indexOf("") < 0 && written.indexOf("null") < 0, written);
    dom.window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
