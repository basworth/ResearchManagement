// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Adam reported that conference deadlines which have already passed seem to disappear from a
// project's "Abstract Submissions" section, while still being listed under Past Deadlines on the
// dashboard. This test exists to establish whether that is actually happening before anything is
// changed — the reading of the code says nothing filters by date, so the question is empirical.
//
// A passed deadline must stay visible on the study page. It's the record of what was submitted
// where, which is exactly what you want to look back at.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ME = "11111111-1111-1111-1111-111111111111";
const STUDY = "aaaaaaaa-0000-0000-0000-000000000001";

// Local-date helpers, deliberately not toISOString(): the sandbox runs in Chicago, so from
// early evening UTC dates are already tomorrow. Same reason todayStr() in the app is hand-rolled.
function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
const PAST = dateOffset(-90);      // long gone
const YESTERDAY = dateOffset(-1);  // only just gone
const FUTURE = dateOffset(45);

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

const meeting = (id, society, name, deadline, extra) => ({
  id, kind: "meeting", updated_at: now,
  data: Object.assign({ id, society, name, deadline, type: "abstract", studyIds: [STUDY] }, extra || {})
});

function boot(phase) {
  const items = [
    { id: ME, kind: "profile", updated_at: now,
      data: { id: ME, name: "Adam Yanke", email: "adam.yanke@rushortho.com", position: "Clinician",
              admin: true, reportsTo: "", alertEmail: "", linkedTo: "", alertEmailAsked: true, degreesAsked: true } },
    { id: STUDY, kind: "study", updated_at: now,
      data: { id: STUDY, title: "Meniscal repair outcomes", phase: phase || "Manuscript",
              pi: "Adam Yanke", team: [], design: "Retrospective", abstracts: [], docs: [],
              milestones: [], meetingNotes: [], authors: [] } },
    meeting("m-past", "AAOS", "2026 Annual Meeting", PAST),
    meeting("m-yesterday", "AANA", "2026 Annual Meeting", YESTERDAY),
    meeting("m-future", "AOSSM", "2027 Annual Meeting", FUTURE),
    { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
      data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} } }
  ];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
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

async function openStudy(dom) {
  const { window } = dom;
  await wait(600);
  window.eval(`currentUser = { id: ${JSON.stringify(ME)}, email: "adam.yanke@rushortho.com" }; syncOnline = true;`);
  window.document.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
  await wait(60);
  window.eval(`tab = "studies"; openStudy("${STUDY}"); render();`);
  await wait(250);
  return window.document;
}
// Open every collapsed section, so "is it in the DOM" and "is it reachable" are tested separately.
async function expandAll(dom) {
  dom.window.eval(`Object.keys(PHASE_SECTIONS).forEach(function(){}); ["abstracts"].forEach(function(id){ studySectionState[id] = true; }); render();`);
  await wait(200);
}

(async () => {
  console.log("\n-- Are past deadlines actually dropped from the study data? --");
  {
    const dom = boot("Manuscript"); const { window } = dom;
    await openStudy(dom);
    const linked = JSON.parse(window.eval(`JSON.stringify(meetingsForStudy(${JSON.stringify(STUDY)}).map(m => m.id))`));
    check("All three linked meetings are still attached to the study",
      linked.length === 3 && linked.indexOf("m-past") >= 0 && linked.indexOf("m-yesterday") >= 0, linked);
    const abs = JSON.parse(window.eval(
      `JSON.stringify(meetingsForStudy(${JSON.stringify(STUDY)}).filter(m => (m.type||"abstract") !== "grant").map(m => m.id))`));
    check("...and all three count as abstract deadlines", abs.length === 3, abs);
    window.close();
  }

  console.log("\n-- Do they render on the page? --");
  {
    const dom = boot("Manuscript");
    const doc = await openStudy(dom);
    await expandAll(dom);
    const body = doc.querySelector('[data-sec-body="abstracts"]');
    check("The Abstract Submissions section exists", !!body);
    const txt = body ? body.textContent : "";
    check("The future deadline is shown (AOSSM)", txt.indexOf("AOSSM") >= 0, txt.slice(0, 300));
    check("The 90-day-old deadline is shown (AAOS)", txt.indexOf("AAOS") >= 0, txt.slice(0, 300));
    check("Yesterday's deadline is shown (AANA)", txt.indexOf("AANA") >= 0, txt.slice(0, 300));
    check("All three rows are present",
      body ? body.querySelectorAll("[data-open-meeting]").length === 3 : false,
      body ? body.querySelectorAll("[data-open-meeting]").length : null);
    check("A past one shows a dash rather than a negative day count", !/-\d+\s*DAYS/i.test(txt), txt.slice(0, 200));
    dom.window.close();
  }

  console.log("\n-- Is the section merely collapsed, per the study's phase? --");
  {
    // Enrolling does not list "abstracts" in PHASE_SECTIONS, so it starts closed. Closed is not
    // the same as gone, and the header must advertise that something is inside.
    const dom = boot("Enrolling");
    const doc = await openStudy(dom);
    const body = doc.querySelector('[data-sec-body="abstracts"]');
    check("The section is still on the page for Enrolling", !!body);
    check("...but starts collapsed", body && body.style.display === "none");
    const header = [...doc.querySelectorAll("[data-sec-toggle]")].find(h => h.dataset.secToggle === "abstracts");
    check("The collapsed header still exists", !!header);
    check("...and shows a count so the content isn't invisible",
      header && /\d/.test(header.textContent), header && header.textContent.trim());
    // The rows are in the DOM even while collapsed, so nothing is lost by the collapse.
    check("All three rows are in the DOM regardless",
      body && body.querySelectorAll("[data-open-meeting]").length === 3,
      body && body.querySelectorAll("[data-open-meeting]").length);
    dom.window.close();
  }

  console.log("\n-- Phases where the section opens by itself --");
  {
    const dom = boot("Manuscript");
    const doc = await openStudy(dom);
    const body = doc.querySelector('[data-sec-body="abstracts"]');
    check("Manuscript opens it", body && body.style.display !== "none");
    dom.window.close();
  }
  {
    const dom = boot("Published");
    const doc = await openStudy(dom);
    const body = doc.querySelector('[data-sec-body="abstracts"]');
    check("Published opens it", body && body.style.display !== "none");
    dom.window.close();
  }
  {
    const dom = boot("Revisions Required");
    const doc = await openStudy(dom);
    const body = doc.querySelector('[data-sec-body="abstracts"]');
    check("Revisions Required starts it collapsed", body && body.style.display === "none");
    dom.window.close();
  }

  console.log("\n-- Nothing in the source filters these rows by date --");
  {
    check("meetingsForStudy has no date test",
      /function meetingsForStudy\(studyId\) \{\s*return state\.meetings\.filter\(m => \(m\.studyIds \|\| \[\]\)\.includes\(studyId\)\);/.test(html));
    check("linkedAbstractMeetings filters only on type",
      /linkedAbstractMeetings = linkedMeetingsAll\.filter\(m => \(m\.type \|\| "abstract"\) !== "grant"\)/.test(html));
    check("abstractDeadlineRowHTML always returns a row",
      !/function abstractDeadlineRowHTML[\s\S]{0,400}return "";/.test(html));
    check("The phase map is documented as collapsing, never hiding",
      /Every section always stays on the page/.test(html));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
