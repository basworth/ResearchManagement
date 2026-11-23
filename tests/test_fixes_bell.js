// Fixes for you to check (23 Nov 2026): a bell with a count of your reports marked done; Works /
// Still broken answers them through answer_feedback (migration 022).
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const U = "test-user-1";
const items = [{ id: U, kind: "profile", updated_at: now, workspace: "spine-singh", data: { id: U, name: "Max Lee", email: "m@x.c", position: "Research assistant", admin: true, alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 999, fieldsChosen: true } }];
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) { win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }); win.confirm = () => true; win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items }) }; } });
const w = dom.window, d = w.document;
let pass = 0, fail = 0;
const check = (n, c, x) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, x === undefined ? "" : "->" + JSON.stringify(x)), fail++);
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await wait(700); w.eval("syncOnline = true;");
  // A stand-in for the two calls the bell makes, recording what it asked for.
  w.eval(`window.__calls = []; window.__fetches = []; const rows = [
      { id: "f1", created_at: "2026-11-14T10:00:00Z", kind: "problem", body: "Date box jumps", status: "done", resolution: "Date boxes save when you leave them.", resolved_at: "2026-11-17T18:00:00Z", confirmation: null },
      { id: "f2", created_at: "2026-11-14T11:00:00Z", kind: "problem", body: "Only one study", status: "done", resolution: "List matches the dashboard.", resolved_at: "2026-11-17T18:00:00Z", confirmation: null } ];
    const q = { select(){ return q; }, eq(k, v){ __calls.push(k + "=" + v); return q; }, is(k, v){ __calls.push(k + " is " + v); return q; }, order(){ return Promise.resolve({ data: rows, error: null }); } };
    sb.from = (t) => { __calls.push("from " + t); return q; };
    sb.rpc = (fn, args) => { __calls.push("rpc " + fn + " " + JSON.stringify(args)); return Promise.resolve({ data: "ok", error: null }); };
    sb.auth.getSession = () => Promise.resolve({ data: { session: { access_token: "t" } } });
    window.fetch = (u, o) => { __fetches.push([u, o && o.body]); return Promise.resolve({ ok: true, json: () => ({}) }); };`);
  await w.eval("loadMyFixes()"); await wait(20);
  const btn = d.getElementById("fixes-btn");
  check("the bell shows with a count of 2", btn.style.display !== "none" && d.getElementById("fixes-count").textContent === "2");
  check("it asks only for my own, done, unanswered reports", /author_id=test-user-1/.test(w.eval("__calls.join('|')")) && /status=done/.test(w.eval("__calls.join('|')")) && /confirmation is null/.test(w.eval("__calls.join('|')")));
  btn.onclick(); await wait(30);
  const sheet = d.getElementById("sheet");
  check("the sheet lists both, with what was done", /Date box jumps/.test(sheet.textContent) && /List matches the dashboard/.test(sheet.textContent));
  sheet.querySelector('[data-fix-works="f1"]').onclick(); await wait(30);
  check("Works answers it as working", /rpc answer_feedback \{"p_id":"f1","p_works":true/.test(w.eval("__calls.join('|')")));
  check("...and the count drops to 1", d.getElementById("fixes-count").textContent === "1");
  sheet.querySelector('[data-fix-broken="f2"]').onclick(); await wait(10);
  sheet.querySelector('[data-fix-why="f2"] textarea').value = "Still only one after refresh";
  sheet.querySelector('[data-fix-send="f2"]').onclick(); await wait(40);
  check("Still broken reopens it with the note", /rpc answer_feedback \{"p_id":"f2","p_works":false,"p_note":"Still only one after refresh"\}/.test(w.eval("__calls.join('|')")));
  check("...and tells Adam", w.eval("__fetches.some(f => /feedback-alert/.test(f[0]) && /reopened/.test(f[1]))"));
  check("the bell hides when nothing is left", btn.style.display === "none");
  const mig = fs.readFileSync(PROJECT + "/supabase/migrations/022-feedback-confirmation.sql", "utf8");
  check("only the author can answer, only once it's done", /author_id is distinct from auth\.uid\(\)/.test(mig) && /status <> 'done'/.test(mig));
  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
