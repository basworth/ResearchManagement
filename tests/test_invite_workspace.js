// An invited person must land in the lab they were invited into. The profile row is created by
// the app on FIRST sign-in — before that row exists there is nothing to say which lab they belong
// to, so the lab travels on the account itself. Without this a newly invited PI was stamped with
// the app's default and filed into Adam's lab, seeing every one of his studies.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const fn = fs.readFileSync(PROJECT + "/supabase/functions/invite-user/index.ts", "utf8");

let pass = 0, fail = 0;
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);

console.log("\n-- The invite decides the lab, server-side --");
check("it reads the inviter's own workspace", /\.eq\("kind", "profile"\)\.eq\("id", callerId\)/.test(fn));
check("...and defaults a new account to it", /const workspace = \(requested && adminRow\) \? requested : inviterWorkspace/.test(fn));
check("only an admin may invite into a different lab", /Only admins can invite into another workspace/.test(fn));
check("a workspace name is validated before it reaches a security rule",
  /\^\[a-z0-9\]\[a-z0-9-\]\{1,40\}\$/.test(fn));
check("the lab is written onto the account", /user_metadata: \{ workspace \}/.test(fn));
check("...at creation, not afterwards", /createUser\(\{\s*email, email_confirm: true, user_metadata/.test(fn.replace(/\n\s*/g, " ")));

console.log("\n-- First sign-in, app side --");
const ME = "99999999-9999-9999-9999-999999999999";
const now = new Date().toISOString();
// Adam's lab, already populated. The newcomer has NO profile row — that's the whole point.
const items = [
  { id: "aaaa1111-0000-0000-0000-000000000001", kind: "study", updated_at: now, workspace: "sports-yanke",
    data: { id: "aaaa1111-0000-0000-0000-000000000001", title: "Adam's cartilage study", phase: "Analysis",
      design: "Prospective (Consented)", pi: "Adam Yanke", team: [], milestones: [], meetingNotes: [],
      authors: [], abstracts: [], docs: [] } },
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now, workspace: "sports-yanke",
    data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} } }
];
const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({
      items, userId: ME, email: "kern@example.com",
      // What Supabase hands back for someone invited into the spine lab.
      userMetadata: { workspace: "spine-singh" } }) };
  }
});
const { window } = dom;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await wait(500);
  window.eval("syncOnline = true;");
  check("the newcomer is placed in the lab they were invited into",
    window.eval("myWorkspace") === "spine-singh", window.eval("myWorkspace"));
  check("...not in the default lab", window.eval("myWorkspace") !== "sports-yanke");

  // The decisive one: what they write must carry their own lab, or the database would file their
  // first study alongside Adam's.
  window.eval(`currentUser = { id: ${JSON.stringify(ME)}, email: "kern@example.com",
                invitedWorkspace: "spine-singh" };
               window.__d = pushItem("study", { id: "s-kern", title: "Cervical disc arthroplasty",
                 phase: "Concept", design: "Retrospective (Chart Review)", priority: "Medium" });`);
  await window.__d; await wait(120);
  const row = items.find(r => r.id === "s-kern");
  check("their first study is stamped to their own lab", row && row.workspace === "spine-singh", row && row.workspace);

  console.log("\n-- Someone with no invite metadata is unaffected --");
  check("the default is still the original lab", /let myWorkspace = "sports-yanke"/.test(html));

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
