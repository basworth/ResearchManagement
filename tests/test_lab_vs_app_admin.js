// Lab admin and app admin stop being the same thing — 16 Oct 2026.
//
// The third reason the tracker wasn't ready for Kern. `invite-user` refused anyone outside
// `app_admins`, so a second PI couldn't invite his own coordinator without being added to it —
// and `is_app_admin()` is what gates granting yourself support access into ANY lab, plus
// list_workspaces(), plus inviting into a lab that isn't yours.
//
// So "let Kern run his own lab" and "give Kern the keys to Adam's lab" were the same action. Not
// a setting anyone would have spotted; the shape of the model.
//
//   lab admin = `admin: true` on your profile. Runs YOUR lab.
//   app admin = a row in app_admins. Reaches across labs. Granted by hand only.
//
// What's held here is mostly about the SEAM: a lab admin must get the controls for their own lab
// and none of the cross-lab ones, and the two must not be confused in either direction.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
// The migration files live in Adam's workspace folder and aren't published to the repo, so in CI
// there is nothing to read. Only the SQL assertions depend on them — the behaviour checks above
// don't, and skipping the whole file to avoid one missing .sql would throw away the part that
// actually exercises the app.
const SQL_DIR = require("path").join(PROJECT, "supabase", "migrations");
const haveSql = fs.existsSync(SQL_DIR);


const USER = "test-user-1";
const now = new Date().toISOString();
const profile = (ws, admin) => ({
  id: USER, kind: "profile", updated_at: now, workspace: ws,
  data: { id: USER, email: "test@example.com", name: "Kern Singh", position: "Clinician",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true, tourSeen: 1,
    linkedTo: "", admin: !!admin },
});

function boot(items, appAdmins) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({
        items, tables: { app_admins: (appAdmins || []).map(id => ({ user_id: id })) } }) };
    },
  });
  return dom.window;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}
const settings = async (w) => {
  w.eval('tab = "settings"; render();');
  await wait(200);
  return w.document.querySelector("#main").textContent;
};

(async () => {
  console.log("\n-- A PI running their own lab --");
  // Lab admin of spine-singh, NOT in app_admins. This is what Kern will be.
  const kern = boot([profile("spine-singh", true)], []);
  await wait(600);
  check("the app knows they run their lab", kern.eval("isAdmin()") === true);
  check("...and that they are not a platform admin", kern.eval("isAppAdmin()") === false);
  const kernSettings = await settings(kern);
  check("they get the invite box, so they can build their team", /Invite a Teammate/.test(kernSettings));
  check("...but NOT support access into other labs", !/Support access/.test(kernSettings),
    kernSettings.slice(0, 200));
  check("...and no way to start another lab", !kern.document.getElementById("invite-newlab"));

  console.log("\n-- An ordinary member of that lab --");
  const member = boot([profile("spine-singh", false)], []);
  await wait(600);
  check("not a lab admin", member.eval("isAdmin()") === false);
  check("not a platform admin", member.eval("isAppAdmin()") === false);
  const memberSettings = await settings(member);
  check("no invite box at all", !/Invite a Teammate/.test(memberSettings));

  console.log("\n-- Adam, who holds both --");
  const adam = boot([profile("sports-yanke", true)], [USER]);
  await wait(600);
  check("runs his lab", adam.eval("isAdmin()") === true);
  check("...and reaches across labs", adam.eval("isAppAdmin()") === true);
  const adamSettings = await settings(adam);
  check("he gets support access", /Support access/.test(adamSettings));
  check("...and the control that starts a new lab", !!adam.document.getElementById("invite-newlab"));

  console.log("\n-- Starting a lab: the name is checked before a round trip --");
  const say = [];
  adam.eval(`window.__said = []; `);
  adam.document.getElementById("invite-email").value = "kern.singh@rushortho.com";
  adam.document.getElementById("invite-newlab").checked = true;
  const ws = adam.document.getElementById("invite-ws");
  ws.value = "Spine Singh!";           // spaces and punctuation — not a workspace name
  adam.document.getElementById("invite-send").click();
  await wait(200);
  const msg1 = adam.document.getElementById("invite-msg").textContent;
  check("a malformed name is refused in words", /lowercase letters, numbers and hyphens/i.test(msg1), msg1);
  check("...and nothing was sent", (adam.eval("sb.__inserted.length") || 0) === 0);

  ws.value = "sports-yanke";           // his own lab, which is what the checkbox is NOT for
  adam.document.getElementById("invite-send").click();
  await wait(200);
  const msg2 = adam.document.getElementById("invite-msg").textContent;
  check("naming his own lab is caught too", /untick the box/i.test(msg2), msg2);

  console.log("\n-- The edge function and the database rule --");
  if (!haveSql) {
    console.log("  skipped — supabase/ isn't in this checkout");
  } else {
  const fn = fs.readFileSync(require("path").join(PROJECT, "supabase", "functions", "invite-user", "index.ts"), "utf8");
  check("a lab admin may invite", /isLabAdmin/.test(fn) && /!adminRow && !isLabAdmin/.test(fn));
  // The dangerous direction: naming another workspace must stay app-admin-only, or a lab admin
  // could invite someone straight into a lab they have nothing to do with.
  check("...but only an app admin may name another lab",
    /\(requested && adminRow\) \? requested : inviterWorkspace/.test(fn));
  check("...and the account listing stays app-admin-only",
    /visibleAccounts\(all, wsById, inviterWorkspace, !!adminRow\)/.test(fn));

  const sql = fs.readFileSync(require("path").join(SQL_DIR, "004-lab-admin.sql"), "utf8");
  check("there's a lab-admin function", /create or replace function public\.is_lab_admin/.test(sql));
  // The whole bug: the profile flag used to insert into app_admins.
  check("the profile trigger no longer writes to app_admins",
    !/insert into app_admins \(user_id\) values \(new\.id\)/.test(sql), "004 still syncs the flag");
  check("a lab admin can only edit profiles in their own lab", /is_lab_admin\(caller\) and same_lab/.test(sql));
  check("the last-app-admin guard survived the move", /Cannot remove the last admin/.test(sql));
  // Nothing may be revoked by a migration — that's Adam's standing rule.
  check("no existing admin is removed", !/delete from (public\.)?app_admins/i.test(sql),
    "004 deletes from app_admins");
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
