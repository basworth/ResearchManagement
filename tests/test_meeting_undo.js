// Reviewing and undoing a meeting update — 26 Oct 2026.
//
// Adam: undo "if the reviewer doesn't like them", for two days "so there is not a large backlog",
// "but keep a history of all changes in case we have to verify versions". Pinned here:
//   - each change undoes on its own, and Undo all undoes the rest
//   - undo never overwrites a value somebody edited after the meeting
//   - after 48 hours the meeting folds into the history — still undoable, record intact
//   - each study's page carries its own record of meeting changes, with undo
//   - an undone change stays on the record, struck through, with who and when
//   - the people the summary was sent to may undo; others may not
//   - ?update=<id> from the email lands on the card
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}
const now = new Date().toISOString();
const U = "test-user-1";
const prof = (id, name, email, admin) => ({ id, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: { id, email, name, position: admin ? "Clinician" : "Research Assistant", reportsTo: "", alertEmail: "",
    alertEmailAsked: true, degreesAsked: true, tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: !!admin } });
const study = (id, data) => ({ id, kind: "study", updated_at: now, workspace: "sports-yanke",
  data: Object.assign({ id, pi: "Adam Yanke", design: "Prospective (Consented)", priority: "Medium" }, data) });
function meeting(created, extra) {
  const until = new Date(Date.parse(created) + 48 * 3600e3).toISOString();
  return { id: "mtg1", kind: "suggestion", updated_at: now, workspace: "sports-yanke", data: Object.assign({
    id: "mtg1", source: "meeting", status: "applied", createdAt: created, undoUntil: until, subject: "Fwd: PFI meeting",
    forwardedBy: "someone-else", forwardedByName: "Adam Yanke", repliedTo: ["adam.yanke@rushortho.com"], copied: ["will.lee@rushortho.com"],
    applied: [
      { id: "c1", type: "enrollment", studyId: "mdakp", study: "MDAKP", label: "Enrolled", from: "7", to: "13", evidence: "up to thirteen",
        undo: { kind: "field", path: "enrollCurrent", prev: "7", now: "13" } },
      { id: "c2", type: "addTeamMember", studyId: "mdakp", study: "MDAKP", label: "Team", from: "", to: "added Morgan Smith", evidence: "add Morgan",
        undo: { kind: "teamRemove", name: "Morgan Smith" } },
      { id: "c3", type: "title", studyId: "ipfi", study: "Integrative PFI", label: "Title", from: "Old title with Synovial Fluid", to: "New title", evidence: "amended",
        undo: { kind: "field", path: "title", prev: "Old title with Synovial Fluid", now: "New title" } },
      { id: "c4", type: "addTask", studyId: "ipfi", study: "Integrative PFI", label: "Task", from: "", to: "Segment controls", evidence: "this week",
        undo: { kind: "taskShelve", taskId: "t-new" } },
    ],
    notApplied: [{ text: "Check the clinical scout sequence", why: "no study" },
      { text: "Task: Excel subject tracker", why: "held — only 30% sure", evidence: "maybe a spreadsheet", study: "MDAKP", studyId: "mdakp", confidence: 0.3 }],
    text: "transcript with [patient removed]",
  }, extra || {}) };
}
function boot(items, url) {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: url || "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items }) };
    } });
  return dom.window;
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const base = (m) => [
  prof(U, "Adam Yanke", "adam.yanke@rushortho.com", true),
  study("mdakp", { title: "Multidisciplinary Approach to Anterior Knee Pain", nickname: "MDAKP", phase: "Enrolling", enrollCurrent: "13", enrollTarget: "30", team: ["Adam Yanke", "Morgan Smith"] }),
  study("ipfi", { title: "New title", nickname: "Integrative PFI", phase: "Enrolling", team: ["Adam Yanke"] }),
  { id: "t-new", kind: "task", updated_at: now, workspace: "sports-yanke", data: { id: "t-new", title: "Segment controls", studyId: "ipfi", assignees: [], done: false, fromMeeting: true } },
  m,
];

(async () => {
  let w = boot(base(meeting(new Date(Date.now() - 3600e3).toISOString())), "http://localhost/?update=mtg1");
  await wait(800);
  let ev = (c) => w.eval(c);
  let d = w.document;
  console.log("\n-- The link in the summary email lands on the meeting --");
  check("?update= opens Settings", ev("tab") === "settings", ev("tab"));
  let card = d.getElementById("mtg-mtg1");
  check("...on that meeting's card", !!card);
  check("the card shows before → after, by study", card && /MDAKP/.test(card.textContent) && /7 →/.test(card.textContent) && /Integrative PFI/i.test(card.textContent));
  check("...and what wasn't applied", card && /scout sequence/.test(card.textContent));
  check("a held item sits under its own study with what was heard", card && (() => {
    const t = card.textContent.replace(/\s+/g, " ");
    const m = t.indexOf("MDAKP"), i = t.indexOf("INTEGRATIVE PFI"), x = t.indexOf("Excel subject tracker"), n = t.indexOf("NO STUDY MATCHED");
    return m >= 0 && x > m && x < i && /Heard: “maybe a spreadsheet”/.test(t) && n > i && t.indexOf("scout sequence") > n;
  })(), card && card.textContent.replace(/\s+/g, " ").slice(0, 600));

  console.log("\n-- Edit, beside Undo, goes to the thing that changed (27 Oct) --");
  check("every live change has an Edit button", card && card.querySelectorAll("[data-mtg-edit]").length >= 4, card && card.querySelectorAll("[data-mtg-edit]").length);
  check("...and its text is clickable too", card && card.querySelector('span[data-mtg-edit][data-mtg-change="c1"]'));
  ev(`editMeetingChange("mtg1", "c4")`);
  await wait(150);
  check("a task change opens the task editor on that task", /Segment controls/.test(d.body.innerHTML) && !!d.querySelector(".sheet, [class*=sheet]"), ev("detailStudyId"));
  ev(`typeof closeSheet === "function" && closeSheet()`);
  ev(`editMeetingChange("mtg1", "c1")`);
  await wait(150);
  check("anything else opens its study", ev("detailStudyId") === "mdakp" && ev("tab") === "studies", { id: ev("detailStudyId"), tab: ev("tab") });
  check("...with that section expanded", ev(`studySectionState.enrollment`) === true);
  ev(`detailStudyId = null; tab = "settings"; render()`);
  await wait(100);
  card = d.getElementById("mtg-mtg1");
  ev(`state.suggestions.find(g => g.id === "mtg1").rerun = "replaced"; render()`);
  await wait(100);
  check("a run replaced by a rerun leaves the up-front list", !d.getElementById("mtg-mtg1"));
  ev(`showAllMeetings = true; render()`);
  await wait(100);
  check("...but stays in the full history, labelled", d.getElementById("mtg-mtg1") && /Replaced by a later run/.test(d.getElementById("mtg-mtg1").textContent));
  ev(`delete state.suggestions.find(g => g.id === "mtg1").rerun; showAllMeetings = false; render()`);
  await wait(100);
  card = d.getElementById("mtg-mtg1");

  console.log("\n-- Approve hides an item as people work through the list (27 Oct) --");
  check("every applied item has an Approve box, every held one a Done box",
    card.querySelectorAll('[data-mtg-review]').length === 6 && /Approve/.test(card.textContent) && /Done/.test(card.textContent),
    card.querySelectorAll('[data-mtg-review]').length);
  const tick = (rid, on) => { const b = d.querySelector(`[data-mtg-review="mtg1"][data-mtg-rid="${rid}"]`); b.checked = on; b.onchange(); };
  tick("c2", true); await wait(80);
  const rec = () => ev(`JSON.stringify(state.suggestions.find(g => g.id === "mtg1"))`);
  check("approving records who and when, as its own field", /"reviewed:c2":\{"by":"Adam Yanke","at":"/.test(rec()), rec().slice(0, 200));
  check("...and the item leaves the list", !/added Morgan Smith/.test(d.getElementById("mtg-mtg1").textContent));
  check("approving changes nothing on the study", ev(`studyById("mdakp").team.indexOf("Morgan Smith")`) >= 0);
  check("the card counts what's been reviewed", /1 of 6 reviewed/.test(d.getElementById("mtg-mtg1").textContent));
  d.querySelector('[data-mtg-show-reviewed="mtg1"]').onclick(); await wait(80);
  check("Show reviewed brings it back, saying who approved it", /added Morgan Smith/.test(d.getElementById("mtg-mtg1").textContent) && /approved by Adam Yanke/.test(d.getElementById("mtg-mtg1").textContent));
  tick("c2", false); await wait(80);
  check("unticking puts it back on the list", !/reviewed:c2/.test(rec()));
  ev(`showReviewedFor["mtg1"] = false; render()`); await wait(80);
  ["c1", "c2", "c3", "c4", "n0", "n1"].forEach(r => ev(`state.suggestions.find(g => g.id === "mtg1")["reviewed:${r}"] = { by: "Carla", at: "${new Date().toISOString()}" }`));
  ev(`render()`); await wait(80);
  check("once everything is reviewed the meeting leaves the up-front list", !d.getElementById("mtg-mtg1"));
  ["c1", "c2", "c3", "c4", "n0", "n1"].forEach(r => ev(`delete state.suggestions.find(g => g.id === "mtg1")["reviewed:${r}"]`));
  ev(`render()`); await wait(80);
  card = d.getElementById("mtg-mtg1");
  check("...and returns if an approval is taken back", !!card);

  console.log("\n-- Undo one change --");
  d.querySelector('[data-mtg-undo="mtg1"][data-mtg-change="c1"]').click(); await wait(100);
  check("enrollment goes back to 7", ev(`studyById("mdakp").enrollCurrent`) === "7");
  const c1 = ev(`JSON.stringify(state.suggestions.find(g => g.id === "mtg1").applied.find(a => a.id === "c1"))`);
  check("the change stays on the record, stamped undone", /"undoneAt"/.test(c1) && /"undoneBy":"Adam Yanke"/.test(c1));
  check("an undone change leaves the working list", !/line-through/.test(d.getElementById("mtg-mtg1").innerHTML));
  ev(`showReviewedFor["mtg1"] = true; render()`); await wait(80);
  check("...and shows struck through under Show reviewed, not gone", /line-through/.test(d.getElementById("mtg-mtg1").innerHTML) && /undone by/.test(d.getElementById("mtg-mtg1").textContent));
  ev(`showReviewedFor["mtg1"] = false; render()`); await wait(80);

  console.log("\n-- Never overwrite a later edit --");
  ev(`studyById("ipfi").title = "Someone fixed it by hand"`);
  ev(`undoMeetingChanges("mtg1", ["c3"])`); await wait(50);
  check("a title edited since the meeting is left alone", ev(`studyById("ipfi").title`) === "Someone fixed it by hand");
  check("...and the card says why", /changed since/.test(ev(`JSON.stringify(state.suggestions.find(g => g.id === "mtg1").applied.find(a => a.id === "c3"))`)));

  console.log("\n-- Undo all --");
  d.querySelector('[data-mtg-undo-all="mtg1"]').click(); await wait(100);
  check("the team member comes off", ev(`studyById("mdakp").team.indexOf("Morgan Smith")`) === -1);
  check("the task the meeting created is removed", !ev(`state.tasks.some(t => t.id === "t-new")`));
  check("the record still holds all four changes", ev(`state.suggestions.find(g => g.id === "mtg1").applied.length`) === 4);

  console.log("\n-- After two days: folded into the history, still undoable --");
  w = boot(base(meeting(new Date(Date.now() - 50 * 3600e3).toISOString())));
  await wait(700);
  w.eval(`tab = "settings"; render();`); await wait(100);
  d = w.document;
  check("an old meeting is not shown up front", !d.getElementById("mtg-mtg1"));
  check("...the history button offers it", /full history \(1\)/.test(d.getElementById("main").textContent));
  w.eval(`showAllMeetings = true; render();`); await wait(50);
  check("the record is there in the history, with every change", d.getElementById("mtg-mtg1") && /Morgan Smith/.test(d.getElementById("mtg-mtg1").textContent));
  check("it says it's in the history and kept", /In the history since/.test(d.getElementById("mtg-mtg1").textContent) && /Kept for good/.test(d.getElementById("mtg-mtg1").textContent));
  check("undo is still offered", !!d.querySelector('[data-mtg-undo="mtg1"]'));
  w.eval(`undoMeetingChanges("mtg1", ["c1"])`); await wait(50);
  check("...and works", w.eval(`studyById("mdakp").enrollCurrent`) === "7");

  console.log("\n-- Each study keeps its own record --");
  w.eval(`openStudy("mdakp"); tab = "studies"; render();`); await wait(100);
  const hist = [...d.querySelectorAll("details")].find(x => /Changes from meetings/.test(x.textContent));
  check("the study page lists the meeting's changes to it", hist && /Changes from meetings \(2\)/.test(hist.textContent) && /Morgan Smith/.test(hist.textContent));
  check("...not other studies' changes", hist && !/New title/.test(hist.textContent));
  check("...shows the one already undone as undone", hist && /undone by/.test(hist.textContent));
  hist.querySelector('[data-mtg-undo="mtg1"][data-mtg-change="c2"]').click(); await wait(80);
  check("...and can undo from there", w.eval(`studyById("mdakp").team.indexOf("Morgan Smith")`) === -1);

  console.log("\n-- Who may undo --");
  w = boot(base(meeting(new Date().toISOString())));
  await wait(700);
  ev = (c) => w.eval(c);
  ev(`currentUser = { id: "ra", email: "will.lee@rushortho.com" }; state.profiles.push({ id: "ra", name: "Will Lee", email: "will.lee@rushortho.com", admin: false })`);
  check("someone the summary was copied to may undo", ev(`canUndoMeeting(state.suggestions.find(g => g.id === "mtg1"))`) === true);
  ev(`currentUser = { id: "x", email: "stranger@rushortho.com" }; state.profiles.push({ id: "x", name: "Stranger", email: "stranger@rushortho.com", admin: false })`);
  check("someone it wasn't sent to may not", ev(`canUndoMeeting(state.suggestions.find(g => g.id === "mtg1"))`) === false);

  console.log("\n-- Who may SEE it: admins, sender, recipients (27 Oct, migration 015) --");
  ev(`tab = "settings"; render()`); await wait(100);
  check("someone it wasn't sent to doesn't see the card at all", !w.document.getElementById("mtg-mtg1"));
  ev(`currentUser = { id: "ra", email: "will.lee@rushortho.com" }; render()`); await wait(100);
  check("a recipient does", !!w.document.getElementById("mtg-mtg1"));
  {
    const sqlPath = require("path").join(__dirname, "..", "supabase", "migrations", "015-meeting-visibility.sql");
    if (!require("fs").existsSync(sqlPath)) console.log("  skip  supabase/ not in this checkout");
    else {
      const body = require("fs").readFileSync(sqlPath, "utf8").replace(/--[^\n]*/g, "");
      const fn = (body.match(/function public\.can_see_meeting[\s\S]*?\$\$;/) || [""])[0];
      check("the database rule: managers, sender, recipients", /sees_whole_lab\(ws\)/.test(fn) && /forwardedBy/.test(fn) && /repliedTo/.test(fn) && /copied/.test(fn) && /alertEmail/.test(fn));
      check("only meeting rows are narrowed", /kind = 'suggestion' and coalesce\(data->>'source', ''\) = 'meeting' and public\.can_see_meeting/.test(body)
        && /kind <> 'study' and not \(kind = 'suggestion' and coalesce\(data->>'source', ''\) = 'meeting'\)/.test(body));
      check("the earlier read branches are all kept", ["is_collaborator(data)", "assigned_on_study_strict", "lab_pi_named(data)", "has_support_access", "lm.workspace in"].every(x => body.includes(x)));
      check("write policies untouched", !/policy "workspace (insert|update|delete)"/.test(body));
    }
  }

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
