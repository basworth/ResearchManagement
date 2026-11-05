// Meetings tab — 5 Nov 2026.
// Adam: "a conference planning tab with a summary of all the upcoming conferences, accepted items,
// rejected, podium, poster, who's making the poster, who's presenting … any planned talks …
// separated based on conference, they should hide once a week past the last date of the conference."
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const U = "test-user-1";
const DAY = 864e5;
const iso = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const md = (d) => { const x = new Date(d + "T12:00:00"); return x.toLocaleString("en-US", { month: "short" }) + " " + x.getDate() + ", " + x.getFullYear(); };
const FUT = "m-future", PAST = "m-past", RECENT = "m-recent", EMPTY = "m-empty";
const meetings = [
  { id: FUT, society: "ORS", name: "ORS Annual Meeting", type: "abstract", deadline: iso(-60), location: "San Francisco, CA",
    dates: `Moscone West, ${md(iso(40)).replace(/, \d{4}$/, "")}–${new Date(iso(44) + "T12:00:00").toLocaleString("en-US", { month: "short" })} ${new Date(iso(44) + "T12:00:00").getDate()}, ${iso(44).slice(0, 4)}. Abstract deadline ${md(iso(-60))}.` },
  { id: PAST, society: "AAOS", name: "Old Meeting", type: "abstract", deadline: iso(-400), dates: `${md(iso(-22)).replace(/, \d{4}$/, "")}–${new Date(iso(-20) + "T12:00:00").toLocaleString("en-US", { month: "short" })} ${new Date(iso(-20) + "T12:00:00").getDate()}, ${iso(-20).slice(0, 4)}` },
  { id: RECENT, society: "AOSSM", name: "Just Ended", type: "abstract", deadline: iso(-200), dates: `${md(iso(-6)).replace(/, \d{4}$/, "")}–${new Date(iso(-4) + "T12:00:00").toLocaleString("en-US", { month: "short" })} ${new Date(iso(-4) + "T12:00:00").getDate()}, ${iso(-4).slice(0, 4)}` },
  { id: "m-video", society: "ORS", name: "Video Theater Submission", type: "abstract", deadline: iso(-90), dates: "Videos due; presented at the annual meeting" },
  { id: "m-late", society: "ORS", name: "ORS Late-Breaking Abstract Submission", type: "abstract", deadline: iso(-20), location: "San Francisco, CA",
    dates: `${md(iso(40)).replace(/, \d{4}$/, "")}–${new Date(iso(44) + "T12:00:00").toLocaleString("en-US", { month: "short" })} ${new Date(iso(44) + "T12:00:00").getDate()}, ${iso(44).slice(0, 4)}` },
  { id: EMPTY, society: "ISAKOS", name: "Nothing of ours", type: "abstract", deadline: iso(-30), dates: `${md(iso(60))}` },
];
const st = (id, info, extra) => ({ id, kind: "study", updated_at: now, workspace: "sports-yanke",
  data: Object.assign({ id, title: "Study " + id, nickname: "N-" + id, pi: "Adam Yanke", team: ["Adam Yanke", "William Lee"], phase: "Analysis", milestones: [], abstractDeadlineInfo: info }, extra || {}) });
const items = [
  { id: U, kind: "profile", updated_at: now, workspace: "sports-yanke", data: { id: U, name: "Adam Yanke", email: "a@b.c", position: "Clinician", admin: true,
    alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 999, fieldsChosen: true } },
  st("pod", { [FUT]: { status: "Accepted", format: "Podium", acceptedFormat: "Podium" } }),
  st("pos", { [FUT]: { status: "Submitted", format: "Poster" } }, { abstracts: [{ id: "a", meeting: "ORS " + iso(40).slice(0, 4), date: iso(-1), status: "Accepted", format: "Poster" }] }),
  st("pend", { [FUT]: { status: "Submitted", format: "Poster" } }),
  st("vid", { "m-video": { status: "Accepted", format: "Podium", acceptedFormat: "Podium" } }),
  st("late", { "m-late": { status: "Accepted", format: "Poster", acceptedFormat: "Poster" } }),
  st("rej", { [FUT]: { status: "Rejected", format: "Poster" } }),
  st("oldone", { [PAST]: { status: "Accepted", format: "Poster", acceptedFormat: "Poster" } }),
  st("recent", { [RECENT]: { status: "Accepted", format: "Poster", acceptedFormat: "Poster" } }),
  ...meetings.map(m => ({ id: m.id, kind: "meeting", updated_at: now, workspace: "sports-yanke", data: m })),
];
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true; win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items }) };
  } });
const w = dom.window, d = w.document;
let pass = 0, fail = 0;
const check = (n, c, x) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, x === undefined ? "" : "->" + JSON.stringify(x)), fail++);
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await wait(700);
  w.eval("syncOnline = true;");
  console.log("\n-- Dates --");
  const dd = JSON.parse(w.eval(`JSON.stringify(conferenceDates(state.meetings.find(m => m.id === ${JSON.stringify(FUT)})))`));
  check("the meeting's dates come from the catalogue text, not the abstract deadline", dd && dd.start === iso(40) && dd.end === iso(44), dd);
  const real = JSON.parse(w.eval(`JSON.stringify(conferenceDates({ deadline: "2026-08-31", dates: "Moscone West Convention Center, San Francisco, CA, Feb 19–23, 2027. Abstract submission deadline Aug 31, 2026 (last day to edit); acceptance notices sent Nov 4, 2026." }))`));
  check("the real ORS 2027 text reads as Feb 19–23, 2027", real && real.start === "2027-02-19" && real.end === "2027-02-23", real);
  check("a lone date isn't taken as the meeting", w.eval(`conferenceDates({ deadline: "2026-09-09", dates: "final decisions January 2027; Specialty Day Mar 5, 2027" })`) === null);
  const span = JSON.parse(w.eval(`JSON.stringify(conferenceDates({ dates: "Mar 30 – Apr 2, 2027" }))`));
  check("a range across months", span && span.start === "2027-03-30" && span.end === "2027-04-02", span);

  console.log("\n-- Which meetings show --");
  w.eval(`tab = "conferences"; render()`); await wait(50);
  const t = d.getElementById("main").textContent;
  check("there's a Meetings tab", !!d.querySelector('nav.tabbar [data-tab="conferences"]'));
  check("an upcoming meeting with our submissions shows", /ORS Annual Meeting/.test(t));
  check("one that ended 4 days ago still shows (a week's grace)", /Just Ended/.test(t));
  check("one that ended 20 days ago is gone", !/Old Meeting/.test(t));
  check("a meeting we have nothing at isn't shown", !/Nothing of ours/.test(t));

  console.log("\n-- What's on a card --");
  check("a late-breaking call for the same meeting joins the main card, not a second one",
    !/ORS Late-Breaking Abstract Submission/.test(t) && w.eval("conferencesToPlan().filter(c => c.m.society === 'ORS').length") === 1);
  check("...with its accepted poster on it, and each study only once", /POSTERS · 2/.test(t) && d.querySelectorAll('[data-conf-role="pos"][data-conf-field="posterBy"]').length === 1, t.match(/POSTERS · \d/));
  check("an undated call (video theater) joins that society's next meeting", !/Video Theater Submission/.test(t) && !!d.querySelector('[data-conf-role="vid"]'));
  check("a late-breaking submission is labelled as such on the meeting card", /Late-breaking/.test(d.querySelector('[data-conf-role="late"]').closest(".milestone-row").textContent));
  check("an 'ORS' acceptance email doesn't mark the late-breaking deadline", w.eval(`abstractEntryForDeadline(studyById("pos"), state.meetings.find(m => m.id === "m-late"))`) === null
    && !!w.eval(`abstractEntryForDeadline(studyById("pos"), state.meetings.find(m => m.id === ${JSON.stringify(FUT)}))`));
  check("...and a role for the late-breaking poster saves against its own deadline", d.querySelector('[data-conf-role="late"][data-conf-field="posterBy"]').dataset.confMtg === "m-late");
  check("podium, posters, awaiting, not accepted are separated", /PODIUM · 2/.test(t) && /POSTERS · 2/.test(t) && /AWAITING DECISION · 1/.test(t) && /NOT ACCEPTED · 1/.test(t), t.slice(0, 600));
  check("an acceptance that came by email counts as an accepted poster", /POSTERS · 2/.test(t) && d.querySelector('[data-conf-role="pos"][data-conf-field="posterBy"]'));
  check("accepted items ask who's presenting / making the poster; pending ones don't",
    !!d.querySelector('[data-conf-role="pod"][data-conf-field="presenter"]') && !d.querySelector('[data-conf-role="pod"][data-conf-field="posterBy"]') && !d.querySelector('[data-conf-role="pend"]'));
  check("it flags accepted items with nobody assigned", /4 accepted items need a presenter or poster maker/.test(t), t.match(/\d+ accepted item[^.]*/));
  const sel = d.querySelector('[data-conf-role="pos"][data-conf-field="posterBy"]');
  sel.value = "William Lee"; sel.onchange(); await wait(30);
  check("picking a poster maker saves it on the study", w.eval(`studyById("pos").abstractDeadlineInfo[${JSON.stringify(FUT)}].posterBy`) === "William Lee");
  check("...and it doesn't count as a hand-set status", !w.eval(`studyById("pos").abstractDeadlineInfo[${JSON.stringify(FUT)}].statusSetAt`));

  console.log("\n-- Talks --");
  d.querySelector(`[data-conf-talk-add="${FUT}"]`).click(); await wait(30);
  d.getElementById("ct-title").value = "When to add a TTO";
  d.getElementById("ct-when").value = iso(41);
  d.getElementById("sheet-save").click(); await wait(50);
  const t2 = d.getElementById("main").textContent;
  check("a talk is added to that meeting", /PLANNED TALKS · 1/.test(t2) && /When to add a TTO/.test(t2));
  check("...saved as a confItem", w.eval(`state.confItems.filter(c => c.type === "talk").length`) === 1);
  check("a meeting with only a talk still shows", w.eval(`conferencesToPlan().length`) >= 2);

  console.log("\n-- Picture --");
  d.querySelector(`[data-conf-pic="${FUT}"]`).click(); await wait(30);
  d.getElementById("cp-url").value = "http://insecure.example/x.jpg";
  d.getElementById("sheet-save").click(); await wait(20);
  check("an insecure address is refused", !!d.getElementById("sheet"));
  d.getElementById("cp-url").value = "https://example.org/sf.jpg";
  d.getElementById("sheet-save").click(); await wait(50);
  check("a picture becomes the banner", /url\('https:\/\/example\.org\/sf\.jpg'\)/.test(d.getElementById("main").innerHTML));
  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
