// Announcements: one note to everybody, sent from the app and recorded — 21 Oct 2026.
//
// Until now this was Adam pasting into Gmail. That leaves no record of what was said, no idea who
// it reached, and the address list re-gathered by hand each time — which is how somebody gets
// left out of the one message that explains why a button moved.
//
// The thing most worth testing here is not the happy path, it is WHO MAY SEND AND TO WHOM. An
// announcement is the one feature in this app that reaches people outside the sender's lab, so a
// client that can name its own audience would quietly undo the lab isolation the whole of
// migration 011 exists to enforce. The audience is therefore clamped on the server, from the
// caller's verified identity, and the test below pins that.
//
// The second thing is the double-send. A note cannot be unsent, and the two ways to send one
// twice are a double-click and a retry after a timeout that actually worked — so an identical
// note inside the hour is a question, not a silent second delivery.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const USER = "test-user-1";
const now = new Date().toISOString();
const profile = (admin) => ({
  id: USER, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: { id: USER, email: "adam.yanke@rushortho.com", name: "Adam Yanke", position: "Clinician",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true,
    tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: !!admin },
});

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}

// Every call the page makes to the announce function, so the UI can be driven without a server.
const calls = [];
let reply = { ok: true, count: 17, labs: ["sports-chahla", "sports-yanke"], sample: [], alreadySent: null, canSendToAllLabs: true };
let status = 200;

const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.fetch = async (url, init) => {
      if (String(url).includes("/functions/v1/announce")) {
        calls.push(JSON.parse((init && init.body) || "{}"));
        return { ok: status < 400, status, json: async () => reply };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    win.supabase = { createClient: () => makeMockSupabase({ items: [profile(true)] }) };
  },
});
const w = dom.window;
const d = w.document;
const ev = (c) => w.eval(c);

(async () => {
  await new Promise(r => setTimeout(r, 700));
  // The shared mock's session carries a user but no access_token, and every function call in the
  // app sends one. Supplied here rather than in supabase_mock.js, which a hundred other tests use.
  ev(`sb.auth.getSession = async () => ({ data: { session: { user: { id: "test-user-1", email: "adam.yanke@rushortho.com" }, access_token: "test-token" } }, error: null });`);
  ev(`tab = "settings"; render();`);
  await new Promise(r => setTimeout(r, 500));

  // 27 Oct 2026, Adam: "i dont see why this needs to be a field in the app". The composer and the
  // history list came out of Settings; announcements are drafted in chat, approved, and sent from
  // there. The announce function below is untouched and still holds every rule it did.
  console.log("\n-- The composer is gone from Settings --");
  check("no subject or note box", !d.getElementById("ann-subject") && !d.getElementById("ann-body"));
  check("no Send or Preview button", !d.getElementById("ann-send") && !d.getElementById("ann-preview"));
  check("no history list", !d.getElementById("ann-history"));
  check("Settings still draws without it", !!d.getElementById("settings-help") && !!d.getElementById("sign-out-btn"));

  console.log("\n-- The function: who may send, and to whom --");
  const FN = path.join(PROJECT, "supabase", "functions", "announce", "index.ts");
  if (!fs.existsSync(FN)) {
    console.log("  (skipped — supabase/functions isn't in this checkout)");
  } else {
    const fn = fs.readFileSync(FN, "utf8");
    check("the caller is identified from their token", /db\.auth\.getUser\(token\)/.test(fn));
    check("...and their role is read from the database, not the request",
      /\.eq\("kind", "profile"\)\.eq\("id", callerId\)/.test(fn) && /from\("app_admins"\)/.test(fn));
    check("a non-admin cannot send at all", /if \(!isAppAdmin && !isLabAdmin\) return json\(\{ error: "Only admins/.test(fn));
    check("THE AUDIENCE IS CLAMPED SERVER-SIDE",
      /const audience = isAppAdmin \? \(requested \|\| "all"\) : callerWorkspace/.test(fn));
    check("...and a lab admin naming another lab is refused outright",
      /You can only announce to your own lab/.test(fn));
    check("the reasoning is written down for whoever reads this next",
      /the client is not the thing that decides who a message reaches/i.test(fn));

    console.log("\n-- Nobody sees anybody else's address --");
    check("one message per recipient", /for \(const r of recipients\)/.test(fn));
    check("...addressed to them alone", /to: r\.email/.test(fn));
    check("...and no bcc pile", !/bcc/i.test(fn));
    check("one person with two accounts gets one copy", /if \(seen\.has\(email\)\) continue/.test(fn));

    console.log("\n-- What was sent is recorded, even when it all bounced --");
    check("an announcement row is written", /kind: "announcement"/.test(fn));
    check("...carrying who it reached and who it didn't", /recipients: delivered, failed/.test(fn));
    check("...and a logging failure doesn't swallow the send",
      /announcement sent but not logged/.test(fn));

    console.log("\n-- Pending invitees are left out on purpose, and it says why --");
    check("the reason is in the source", /PENDING INVITES ARE NOT INCLUDED, deliberately/.test(fn));


    console.log("\n-- One address failing doesn't take the batch down --");
    check("each send is caught on its own", /failed\.push\(\{ email: r\.email/.test(fn));

    console.log("\n-- CORS matches every other function --");
    check("it allows the headers supabase-js sends",
      /"Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-supabase-api-version"/.test(fn));
  }

  console.log("\n-- The page calls it with the two headers that have always worked --");
  check("Content-Type and Authorization only",
    /callAnnounceFn[\s\S]{0,600}headers: \{ "Content-Type": "application\/json", "Authorization": "Bearer " \+ tok \}/.test(html));
  check("...and the reason is written beside it, so nobody 'tidies' it later",
    /that only bit callers using supabase-js's functions\.invoke\(\)/.test(html));

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
