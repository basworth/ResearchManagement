// Things waiting on you — 29 Oct 2026.
//
// Adam: an admin request sat unnoticed. "There needs to be some notification that there is an
// action item for me, like a little red circle with a number on it next to the settings area. And
// as I click through, I see which items require attention" — and "not just for me, but really
// anybody". Also: "why would I do a separate approval when there was already specific wording …
// saying who can be an admin on a given lab?"
//
// What these tests hold:
//   1. A red count on Settings = suggested updates waiting on you + meeting cards to review +
//      (approver only) admin requests; inside, the heading and the group carry it, and the group opens.
//   2. Anyone's own tasks due today or overdue put a count on Tasks.
//   3. Research staff ask for lab admin automatically, once; the server applies the lab rule.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const ME = "test-user-1";
const now = new Date().toISOString();
const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const nextWeek = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
const prof = (id, name, extra) => ({ id, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: Object.assign({ id, email: id + "@example.com", name, position: "Research assistant", reportsTo: "", alertEmail: "",
    alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 99, fieldsChosen: true, linkedTo: "", admin: false }, extra || {}) });
function boot({ asAdam, items, tables, fetchLog }) {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      const orig = win.fetch;
      win.fetch = (url, opts) => {
        if (!/functions\/v1\/admin-requests/.test(String(url))) return orig ? orig(url, opts) : Promise.reject(new Error("offline"));
        if (fetchLog) fetchLog.push({ url: String(url), body: opts && opts.body });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, auto: true }) });
      };
      win.supabase = { createClient: () => {
        const c = makeMockSupabase({ items, tables: tables || {}, rpcs: asAdam ? { is_app_admin: true } : {} });
        const gs = c.auth.getSession;   // a real session carries a token; the mock's doesn't
        c.auth.getSession = async () => { const r = await gs(); if (r.data && r.data.session) r.data.session.access_token = "tok"; return r; };
        return c;
      } };
    } });
  return dom.window;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}
const badge = (w, t) => { const b = w.document.querySelector(`nav.tabbar [data-tab="${t}"] .act-badge`); return b ? b.textContent : null; };

(async () => {
  console.log("\n-- Adam: two admin requests and an update waiting --");
  const w = boot({ asAdam: true,
    items: [prof(ME, "Adam Yanke", { admin: true, position: "Clinician" }),
      { id: "g1", kind: "suggestion", updated_at: now, workspace: "sports-yanke", data: { id: "g1", status: "pending", source: "email", subject: "Decision on AJSM-26-001", text: "Your manuscript AJSM-26-001 is under review.", parserVersion: 999, createdAt: now, changes: [] } }],
    tables: { admin_requests: [{ id: "r1", user_id: "u2", status: "pending", reason: "", requested_at: now }, { id: "r2", user_id: "u3", status: "pending", reason: "", requested_at: now }] } });
  await wait(900);
  w.eval("isAppAdmin = () => true; refreshAdminRequestCount()");
  await wait(100);
  w.eval("render()");
  check("Settings carries a red count of everything waiting", badge(w, "settings") === "3", badge(w, "settings"));
  w.eval(`tab = "settings"; render()`); await wait(80);
  const d = w.document;
  const sugTitle = [...d.querySelectorAll(".section-title")].find(e => /Suggested Updates/.test(e.textContent));
  check("the Suggested Updates heading shows its own count", sugTitle && /1/.test((sugTitle.querySelector(".act-badge") || {}).textContent || ""), sugTitle && sugTitle.textContent);
  const cat = d.querySelector('.settings-category[data-cat="Account & user settings"]');
  check("the category holding admin requests shows 2", cat && (cat.querySelector(".act-badge") || {}).textContent === "2", cat && cat.textContent);
  const grp = d.querySelector('details.settings-group[data-sg="Admin Access"]');
  check("...and the Admin Access group is badged and already open", grp && grp.open && (grp.querySelector("summary .act-badge") || {}).textContent === "2");
  const other = d.querySelector('.settings-category[data-cat="Lab setup"]');
  check("headings with nothing waiting stay plain", other && !other.querySelector(".act-badge"));

  console.log("\n-- Anyone: their own due tasks --");
  const log = [];
  const w2 = boot({ fetchLog: log, items: [prof(ME, "Casey Student"),
    { id: "t1", kind: "task", updated_at: now, workspace: "sports-yanke", data: { id: "t1", title: "Overdue thing", due: yesterday, assignees: ["Casey Student"], done: false, notes: "" } },
    { id: "t2", kind: "task", updated_at: now, workspace: "sports-yanke", data: { id: "t2", title: "Later", due: nextWeek, assignees: ["Casey Student"], done: false, notes: "" } },
    { id: "t3", kind: "task", updated_at: now, workspace: "sports-yanke", data: { id: "t3", title: "Someone else's", due: yesterday, assignees: ["Pat Other"], done: false, notes: "" } }] });
  await wait(900);
  w2.eval("render()");
  check("Tasks shows 1 — only their own task that's due", badge(w2, "tasks") === "1", badge(w2, "tasks"));
  check("an RA with nothing to act on has no Settings badge", badge(w2, "settings") === null);
  w2.eval(`state.tasks.find(t => t.id === "t1").done = true; render()`);
  check("ticking it off clears the count", badge(w2, "tasks") === null);

  console.log("\n-- Research staff become lab admins without anyone approving --");
  await wait(1700);
  const asks = log.filter(x => /admin-requests/.test(x.url));
  check("a research assistant's app asks for lab admin by itself", asks.length === 1 && /"action":"request"/.test(asks[0].body), asks);
  await wait(300);
  check("...once, remembered on the profile", w2.eval(`profileFor("${ME}").adminAutoAsked`) === true, w2.eval(`JSON.stringify(profileFor("${ME}"))`));
  w2.eval("maybeAutoRequestAdmin()"); await wait(50);
  check("...and not again", log.filter(x => /admin-requests/.test(x.url)).length === 1);
  const log3 = [];
  const w3 = boot({ fetchLog: log3, items: [prof(ME, "Sam Resident", { position: "Orthopedic resident" })] });
  await wait(2500);
  check("a resident doesn't (that still goes to Adam)", !log3.some(x => /admin-requests/.test(x.url)));

  console.log("\n-- The server applies the lab rule --");
  const fnPath = PROJECT + "/supabase/functions/admin-requests/index.ts";
  if (!fs.existsSync(fnPath)) console.log("  skip  supabase/ not in this checkout");
  else {
    const fn = fs.readFileSync(fnPath, "utf8");
    check("research assistants and coordinators qualify", /\/\^research assistant\$\/i\.test\(pos\)/.test(fn) && /CRCM\?\\b\|coordinator\|research manager/.test(fn));
    check("so does the lab's own PI, from lab_pis", /from\("lab_pis"\)\.select\("pi_name"\)\.eq\("workspace", ws\)/.test(fn));
    check("only for their own lab (the profile's), and Adam gets an FYI, not a task", /if \(prof && ws && \(isLabPi \|\| isResearchStaff\)\)/.test(fn) && /nothing for you to do/.test(fn));
    check("everyone else still waits for Adam", /Admin access requested by \$\{name\}/.test(fn));
  }

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
