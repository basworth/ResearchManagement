// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// "Ask the study team for an update".
//
// Chasing a study by hand meant looking up who was on it, working out which address each of them
// actually reads, and retyping the same message. The risk in automating it is the quiet failure:
// tapping Send, seeing "sent", and assuming the coordinator who never signed up was told. So most
// of what's checked here is about who is NOT reached, and whether the app says so out loud.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ME = "11111111-1111-1111-1111-111111111111";
const WILL = "22222222-2222-2222-2222-222222222222";
const TJ = "33333333-3333-3333-3333-333333333333";
const RUSHY = "44444444-4444-4444-4444-444444444444";
const STUDY = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER = "aaaaaaaa-0000-0000-0000-000000000002";

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

const profile = (id, name, email, extra) => ({
  id, kind: "profile", updated_at: now,
  data: Object.assign({ id, name, email, position: "Research Coordinator", admin: false,
    reportsTo: "Adam Yanke", alertEmail: "", linkedTo: "", alertEmailAsked: true, degreesAsked: true }, extra || {})
});

// `fnReply` is what the (mocked) request-update edge function answers with; `url` lets a test
// boot the page as if someone had just tapped a study link in an email.
function boot(opts) {
  opts = opts || {};
  const calls = [];
  const items = [
    profile(ME, "Adam Yanke", "adam.yanke@rushortho.com", { position: "Clinician", admin: true, reportsTo: "" }),
    profile(WILL, "William Lee", "will.lee@rushortho.com"),
    profile(TJ, "Thomas Turinske", "tj@rushortho.com"),
    // Signed in, but reads a rush.edu address — mail there is being quarantined, so this person
    // is reachable-but-doubtful, which is a third state, not a green tick.
    profile(RUSHY, "Catherine Yuh", "cat@rushortho.com", { alertEmail: "catherine_yuh@rush.edu" }),
    { id: STUDY, kind: "study", updated_at: now,
      data: Object.assign({ id: STUDY, title: "Meniscal repair outcomes", nickname: "Meniscus",
        phase: "Data Collection", design: "Retrospective (Non-Consented)", irb: "ORA-24-001",
        pi: "Adam Yanke", team: ["William Lee", "Divesh Sachdev"], abstracts: [], docs: [],
        milestones: [], meetingNotes: [], authors: [], updateRequests: [] }, opts.studyExtra || {}) },
    { id: OTHER, kind: "study", updated_at: now,
      data: { id: OTHER, title: "Cartilage thickness", nickname: "Cartilage", phase: "Manuscript",
        design: "Basic Science", pi: "Adam Yanke", team: [], abstracts: [], docs: [],
        milestones: [], meetingNotes: [], authors: [], updateRequests: [] } },
    { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
      data: { id: "00000000-0000-0000-0000-000000000001",
              names: ["Adam Yanke", "William Lee", "Thomas Turinske", "Catherine Yuh", "Divesh Sachdev"], degrees: {} } }
  ];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true,
    url: opts.url || "https://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.fetch = async (url, init) => {
        const u = String(url);
        if (u.indexOf("/functions/v1/request-update") >= 0) {
          calls.push(JSON.parse((init && init.body) || "{}"));
          const r = opts.fnReply || { ok: true, sent: ["William Lee"], failed: [], skipped: ["Divesh Sachdev"] };
          if (r.__status) return { ok: false, status: r.__status, json: async () => r };
          return { ok: true, status: 200, json: async () => r };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      };
      win.supabase = { createClient: () => {
        const c = makeMockSupabase({ items });
        c.auth.getSession = async () => ({ data: { session: { access_token: "tok", user: { id: ME, email: "adam.yanke@rushortho.com" } } }, error: null });
        return c;
      } };
    }
  });
  return { dom, calls, items };
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
async function openWorklist(dom) {
  const win = await signedIn(dom);
  win.eval(`tab = "worklist"; worklistLayout = "table"; worklistStatus = "all"; worklistPerson = "all"; render();`);
  await wait(250);
  return win;
}
async function openStudyPage(dom, id) {
  const win = await signedIn(dom);
  win.eval(`tab = "studies"; openStudy("${id || STUDY}"); render();`);
  await wait(250);
  return win;
}
const askBtn = (doc, id) => doc.querySelector(`[data-ask-update="${id || STUDY}"]`);
const sheetText = (doc) => { const s = doc.getElementById("sheet"); return s ? s.textContent : ""; };
const toastText = (doc) => doc.getElementById("toast").textContent;
const studyData = (win, id) => win.eval(`JSON.stringify(studyById(${JSON.stringify(id || STUDY)}))`);

(async () => {
  console.log("\n-- The button is where he asked for it --");
  {
    const { dom } = boot();
    const win = await openWorklist(dom);
    const doc = win.document;
    const btn = askBtn(doc);
    check("Every Worklist row carries one", doc.querySelectorAll("[data-ask-update]").length >= 2,
      doc.querySelectorAll("[data-ask-update]").length);
    check("...and it's on this study's row", !!btn);
    check("It sits in the last cell of the row", (() => {
      const tr = btn.closest("tr");
      return tr && tr.lastElementChild.contains(btn);
    })());
    check("The column has a header, so the table isn't ragged",
      /Study Team/.test(doc.querySelector("table.wl thead").textContent));
    check("Header count matches the cells in a row", (() => {
      const ths = doc.querySelectorAll("table.wl thead th").length;
      const tds = doc.querySelector("table.wl tbody tr").children.length;
      return ths === tds;
    })(), [doc.querySelectorAll("table.wl thead th").length, doc.querySelector("table.wl tbody tr").children.length]);
    check("Never asked, so it invites a first ask", /Ask for update/.test(btn.textContent), btn.textContent);
    dom.window.close();
  }

  console.log("\n-- ...and on the study page too --");
  {
    const { dom } = boot();
    const win = await openStudyPage(dom);
    check("There's a button on the study itself", !!win.document.getElementById("ask-update-btn"));
    check("Edit Study is still there next to it", !!win.document.getElementById("edit-study-btn"));
    dom.window.close();
  }

  console.log("\n-- Tapping it on the Worklist doesn't navigate away --");
  {
    const { dom } = boot();
    const win = await openWorklist(dom);
    askBtn(win.document).click();
    await wait(200);
    check("The sheet opened", !!win.document.getElementById("sheet"));
    check("Still on the Worklist, not inside the study",
      win.eval("tab") === "worklist" && win.eval("String(detailStudyId)") !== STUDY,
      [win.eval("tab"), win.eval("String(detailStudyId)")]);
    dom.window.close();
  }

  console.log("\n-- The sheet says exactly who it will and won't reach --");
  {
    const { dom } = boot();
    const win = await openWorklist(dom);
    askBtn(win.document).click();
    await wait(200);
    const t = sheetText(win.document);
    check("Names the teammate who has a login", /William Lee/.test(t), t.slice(0, 300));
    check("...with the address it will actually use", /will\.lee@rushortho\.com/.test(t));
    check("Names the teammate who does NOT, as not included", /Divesh Sachdev/.test(t) && /Not included/i.test(t));
    check("...and says why, in plain words", /signed in/i.test(t), t);
    check("Doesn't offer to email you about your own study", !/Adam Yanke/.test(t), t);
    check("There's somewhere to type a specific ask", !!win.document.getElementById("ur-note"));
    check("...which is optional", /optional/i.test(t));
    check("The send button says Send, not Save", /Send/.test(win.document.getElementById("sheet-save").textContent));
    dom.window.close();
  }

  console.log("\n-- A quarantined domain is its own warning, not a green tick --");
  {
    const { dom } = boot({ studyExtra: { team: ["William Lee", "Catherine Yuh"] } });
    const win = await openWorklist(dom);
    askBtn(win.document).click();
    await wait(200);
    const t = sheetText(win.document);
    check("Catherine is still listed as a recipient", /Catherine Yuh/.test(t));
    check("...but flagged as possibly not arriving", /quarantin/i.test(t), t);
    check("...naming the domain that's the problem", /rush\.edu/.test(t), t);
    dom.window.close();
  }

  console.log("\n-- Nobody to ask: the two reasons read differently --");
  {
    // On the team, but nobody has an account.
    const { dom } = boot({ studyExtra: { pi: "Adam Yanke", team: ["Divesh Sachdev"] } });
    const win = await openWorklist(dom);
    askBtn(win.document).click();
    await wait(200);
    const t = sheetText(win.document);
    check("Says the team can't be emailed yet", /Nobody on this study can be emailed/i.test(t), t);
    check("...naming who that is", /Divesh Sachdev/.test(t), t);
    check("...points at the invite screen", /Invite teammate/i.test(t), t);
    check("...and does NOT pretend to send", !win.document.getElementById("ur-note"));
    dom.window.close();
  }
  {
    // Nobody on it at all except him.
    const { dom } = boot({ studyExtra: { pi: "Adam Yanke", team: [] } });
    const win = await openWorklist(dom);
    askBtn(win.document).click();
    await wait(200);
    const t = sheetText(win.document);
    check("Says there's no team listed", /No one is listed/i.test(t), t);
    check("...points at Edit Study, which is the actual fix", /Edit Study/.test(t));
    dom.window.close();
  }

  console.log("\n-- Sending --");
  {
    const { dom, calls } = boot();
    const win = await openWorklist(dom);
    askBtn(win.document).click();
    await wait(200);
    win.document.getElementById("ur-note").value = "  where are we on the IRB amendment?  ";
    win.document.getElementById("sheet-save").click();
    await wait(400);
    check("The function was called once", calls.length === 1, calls);
    check("...with this study's id", calls[0] && calls[0].studyId === STUDY, calls[0]);
    check("...and the note, trimmed", calls[0] && calls[0].note === "where are we on the IRB amendment?", calls[0]);
    check("No recipient list is sent from the browser", calls[0] && calls[0].to === undefined && calls[0].emails === undefined, calls[0]);
    check("It confirms, naming who was asked", /William Lee/.test(toastText(win.document)), toastText(win.document));
    dom.window.close();
  }

  console.log("\n-- Everyone starts ticked, and anyone can be unticked --");
  {
    const { dom, calls } = boot({ studyExtra: { team: ["William Lee", "Thomas Turinske"] } });
    const win = await openWorklist(dom);
    askBtn(win.document).click();
    await wait(200);
    const picks = [...win.document.querySelectorAll(".ur-pick")];
    check("There's a tick box per recipient", picks.length === 2, picks.length);
    check("...all ticked to begin with", picks.every(c => c.checked));
    check("It says you can untick", /Untick anyone/i.test(sheetText(win.document)));
    // Drop TJ.
    const tj = picks.find(c => c.dataset.name === "Thomas Turinske");
    tj.checked = false;
    tj.dispatchEvent(new win.Event("change", { bubbles: true }));
    win.document.getElementById("sheet-save").click();
    await wait(400);
    check("Only the ticked name is sent to the server",
      JSON.stringify(calls[0].only) === JSON.stringify(["William Lee"]), calls[0]);
    const e = JSON.parse(studyData(win)).updateRequests[0];
    check("The unticked person is recorded as unticked, not as missing",
      JSON.stringify(e.unticked) === JSON.stringify(["Thomas Turinske"]), e);
    check("...and is NOT lumped in with people who have no account",
      (e.skipped || []).indexOf("Thomas Turinske") < 0, e.skipped);
    dom.window.close();
  }

  console.log("\n-- Unticking everyone doesn't quietly send nothing --");
  {
    const { dom, calls } = boot();
    const win = await openWorklist(dom);
    askBtn(win.document).click();
    await wait(200);
    [...win.document.querySelectorAll(".ur-pick")].forEach(c => {
      c.checked = false;
      c.dispatchEvent(new win.Event("change", { bubbles: true }));
    });
    await wait(120);
    check("It warns as soon as the list empties",
      win.document.getElementById("ur-none").style.display === "block");
    win.document.getElementById("sheet-save").click();
    await wait(300);
    check("Nothing was sent", calls.length === 0, calls);
    check("The sheet stays open, rather than closing on a no-op", !!win.document.getElementById("sheet"));
    check("...and says what to do", /Tick at least one/i.test(toastText(win.document)), toastText(win.document));
    check("Nothing was logged", JSON.parse(studyData(win)).updateRequests.length === 0);
    dom.window.close();
  }

  console.log("\n-- What gets written down --");
  {
    const { dom } = boot();
    const win = await openWorklist(dom);
    askBtn(win.document).click();
    await wait(200);
    win.document.getElementById("ur-note").value = "any movement?";
    win.document.getElementById("sheet-save").click();
    await wait(400);
    const s = JSON.parse(studyData(win));
    check("One entry was logged", s.updateRequests.length === 1, s.updateRequests);
    const e = s.updateRequests[0];
    check("...stamped with a time", !!e.at && !isNaN(new Date(e.at).getTime()), e.at);
    check("...and who did the asking", e.by === "Adam Yanke", e.by);
    check("...the note as sent", e.note === "any movement?", e.note);
    check("...who it reached, per the SERVER, not the sheet", JSON.stringify(e.sentTo) === JSON.stringify(["William Lee"]), e.sentTo);
    check("...and who it missed", e.skipped.indexOf("Divesh Sachdev") >= 0, e.skipped);
    dom.window.close();
  }

  console.log("\n-- The log is append-only --");
  {
    const old = { id: "old", at: "2026-01-01T12:00:00.000Z", by: "Adam Yanke", note: "first ask", sentTo: ["William Lee"], skipped: [] };
    const { dom } = boot({ studyExtra: { updateRequests: [old] } });
    const win = await openWorklist(dom);
    askBtn(win.document).click();
    await wait(200);
    win.document.getElementById("sheet-save").click();
    await wait(400);
    const s = JSON.parse(studyData(win));
    check("The earlier ask is still there", s.updateRequests.length === 2, s.updateRequests.length);
    check("...completely untouched", JSON.stringify(s.updateRequests[0]) === JSON.stringify(old), s.updateRequests[0]);
    dom.window.close();
  }

  console.log("\n-- So you don't chase the same study twice in a day --");
  {
    const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
    const withLog = (at) => boot({ studyExtra: { updateRequests: [{ id: "x", at, by: "Thomas Turinske", note: "any news?", sentTo: ["William Lee"], skipped: [] }] } });

    let { dom } = withLog(iso(0));
    let win = await openWorklist(dom);
    check("Asked an hour ago reads as today", /Asked today/.test(askBtn(win.document).textContent), askBtn(win.document).textContent);
    check("...and the button is dimmed, not hidden", /opacity/.test(askBtn(win.document).getAttribute("style")));
    check("...still tappable, because sometimes you do mean it", !askBtn(win.document).disabled);
    dom.window.close();

    ({ dom } = withLog(iso(1)));
    win = await openWorklist(dom);
    check("One day reads as 1d, not 1 days", /Asked 1d ago/.test(askBtn(win.document).textContent), askBtn(win.document).textContent);
    dom.window.close();

    ({ dom } = withLog(iso(9)));
    win = await openWorklist(dom);
    check("Nine days later it says so", /Asked 9d ago/.test(askBtn(win.document).textContent), askBtn(win.document).textContent);
    check("...and is no longer dimmed", !/opacity/.test(askBtn(win.document).getAttribute("style")));
    dom.window.close();

    ({ dom } = withLog(iso(3)));
    win = await openWorklist(dom);
    askBtn(win.document).click();
    await wait(200);
    const t = sheetText(win.document);
    check("The sheet shows who asked last time", /Thomas Turinske/.test(t), t);
    check("...when", /3 days ago/.test(t), t);
    check("...and what they asked", /any news\?/.test(t), t);
    dom.window.close();
  }

  console.log("\n-- The count is per study, not global --");
  {
    const { dom } = boot({ studyExtra: { updateRequests: [{ id: "x", at: new Date().toISOString(), by: "Adam Yanke", note: "", sentTo: [], skipped: [] }] } });
    const win = await openWorklist(dom);
    check("The chased study says so", /Asked today/.test(askBtn(win.document, STUDY).textContent));
    check("The other one still invites a first ask", /Ask for update/.test(askBtn(win.document, OTHER).textContent),
      askBtn(win.document, OTHER).textContent);
    dom.window.close();
  }

  console.log("\n-- When the send fails --");
  {
    const { dom } = boot({ fnReply: { error: "SMTP refused the connection" } });
    const win = await openWorklist(dom);
    askBtn(win.document).click();
    await wait(200);
    win.document.getElementById("sheet-save").click();
    await wait(400);
    const t = toastText(win.document);
    check("It says it couldn't", /Couldn't send/i.test(t), t);
    check("...and passes on why", /SMTP refused/.test(t), t);
    check("Nothing is logged, because nothing was sent",
      JSON.parse(studyData(win)).updateRequests.length === 0);
    dom.window.close();
  }

  console.log("\n-- When the server is behind the app --");
  {
    const { dom } = boot({ fnReply: { __status: 404, error: "Not Found" } });
    const win = await openWorklist(dom);
    askBtn(win.document).click();
    await wait(200);
    win.document.getElementById("sheet-save").click();
    await wait(400);
    const t = toastText(win.document);
    check("It explains the deploy lag rather than looking broken", /hasn't picked up this feature/i.test(t), t);
    dom.window.close();
  }

  console.log("\n-- Partly sent is reported as partly sent --");
  {
    const { dom } = boot({ fnReply: { ok: true, sent: ["William Lee"], failed: ["Thomas Turinske"], skipped: [] } });
    const win = await openWorklist(dom);
    askBtn(win.document).click();
    await wait(200);
    win.document.getElementById("sheet-save").click();
    await wait(400);
    const t = toastText(win.document);
    check("It does not claim a clean send", !/^Asked/.test(t), t);
    check("...and names who it couldn't reach", /Thomas Turinske/.test(t), t);
    const e = JSON.parse(studyData(win)).updateRequests[0];
    check("The failure is written down too", e && JSON.stringify(e.failed) === JSON.stringify(["Thomas Turinske"]), e);
    dom.window.close();
  }

  console.log("\n-- The link in the email opens the study --");
  {
    // No manual call: arriving at ?study=<id> and signing in should land on the study by itself,
    // which is the whole point — the recipient taps once, from an email, and is looking at it.
    const { dom } = boot({ url: "https://localhost/?study=" + STUDY });
    const win = await signedIn(dom);
    check("Sign-in alone lands on the Studies tab", win.eval("tab") === "studies", win.eval("tab"));
    check("...with that study open", win.eval("String(detailStudyId)") === STUDY, win.eval("String(detailStudyId)"));
    check("The id is spent, so a refresh doesn't replay it", win.eval("pendingStudyId") === "");
    check("...and asking again is a no-op", win.eval("openPendingStudy()") === false);
    check("The URL no longer carries it, so neither does a shared link",
      win.eval("window.location.search") === "", win.eval("window.location.search"));
    dom.window.close();
  }

  console.log("\n-- A link to a study that isn't there any more --");
  {
    const { dom } = boot({ url: "https://localhost/?study=nope-0000" });
    const win = await signedIn(dom);
    check("Nothing is opened", win.eval("String(detailStudyId)") !== "nope-0000", win.eval("String(detailStudyId)"));
    check("...and it says so rather than doing nothing visible",
      /didn't open|removed/i.test(toastText(win.document)), toastText(win.document));
    check("It's still consumed, so it can't nag on every sign-in", win.eval("pendingStudyId") === "");
    dom.window.close();
  }

  console.log("\n-- An ordinary visit is unaffected --");
  {
    const { dom } = boot();
    const win = await signedIn(dom);
    check("No pending study", win.eval("pendingStudyId") === "");
    check("...and nothing is opened", win.eval("openPendingStudy()") === false);
    dom.window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
