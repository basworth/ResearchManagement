// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// A reset or invite link that's already been spent used to dump people on a bare sign-in box
// with no explanation — which is exactly what Adam saw, and almost certainly what Carolina saw.
// GoTrue signals this by redirecting with error_code=otp_expired in the URL instead of a
// session, so these tests drive the app at each URL shape it can be handed.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const mockItems = [
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta",
    data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} }, updated_at: now }
];

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

// Boots the app at a given URL, optionally with a live session already in place.
function boot(url, opts) {
  opts = opts || {};
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url,
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => {
        const client = makeMockSupabase({ items: mockItems });
        if (opts.session) {
          client.auth.getSession = async () => ({
            data: { session: { user: { id: "u1", email: "adam.yanke@rushortho.com" } } }, error: null
          });
        }
        return client;
      } };
    }
  });
  return dom;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const msgOf = doc => (doc.getElementById("login-msg") || {}).textContent || "";
const signedIn = doc => doc.body.classList.contains("authed");
const shown = (doc, id) => { const el = doc.getElementById(id); return !!el && el.style.display !== "none"; };

const SITE = "https://rushsportsresearch.netlify.app/";
const DEAD = SITE + "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired";
const GOOD_RECOVERY = SITE + "#access_token=fake&refresh_token=fake&token_type=bearer&type=recovery";
const GOOD_INVITE = SITE + "#access_token=fake&refresh_token=fake&token_type=bearer&type=invite";

(async () => {
  console.log("\n-- A spent link explains itself instead of showing a blank sign-in box --");
  {
    const { window } = boot(DEAD), doc = window.document;
    await wait(700);
    const msg = msgOf(doc);
    check("The login screen carries a message at all", msg.trim().length > 0, msg);
    check("...that says the link was already used or expired",
      /already opened|no longer valid|scanner/i.test(msg), msg);
    check("...and does NOT leave the user signed in", !signedIn(doc));
    check("The reset offer is opened up, so the fix is one tap away", shown(doc, "login-reset-offer"));
    check("The password box is NOT offered — there's no session to save against",
      !shown(doc, "login-recovery"));
    check("The spent token is scrubbed from the URL so a refresh doesn't replay it",
      window.location.hash === "" && window.location.href.indexOf("otp_expired") < 0,
      window.location.href);
    window.close();
  }

  console.log("\n-- A dead link beats a stale session, rather than quietly logging you in --");
  {
    const { window } = boot(DEAD, { session: true }), doc = window.document;
    await wait(700);
    check("Still shows the explanation", /already opened|no longer valid|scanner/i.test(msgOf(doc)), msgOf(doc));
    check("Not dropped into the app as their old self", !signedIn(doc));
    window.close();
  }

  console.log("\n-- A healthy recovery link still reaches the password box --");
  {
    const { window } = boot(GOOD_RECOVERY, { session: true }), doc = window.document;
    await wait(700);
    check("Password box shown", shown(doc, "login-recovery"));
    check("Sign-in fields hidden", !shown(doc, "login-fields"));
    check("No error message", msgOf(doc).trim() === "", msgOf(doc));
    check("Copy is the reset wording, not the welcome wording",
      /new password/i.test(doc.getElementById("recovery-intro").textContent),
      doc.getElementById("recovery-intro").textContent);
    window.close();
  }

  console.log("\n-- A healthy invite link still gets the welcome wording --");
  {
    const { window } = boot(GOOD_INVITE, { session: true }), doc = window.document;
    await wait(700);
    check("Password box shown", shown(doc, "login-recovery"));
    check("Copy welcomes a new person",
      /Welcome/i.test(doc.getElementById("recovery-intro").textContent),
      doc.getElementById("recovery-intro").textContent);
    window.close();
  }

  console.log("\n-- A plain visit is untouched by any of this --");
  {
    const { window } = boot(SITE), doc = window.document;
    await wait(700);
    check("No error message on a normal visit", msgOf(doc).trim() === "", msgOf(doc));
    check("Reset offer stays hidden until it's earned", !shown(doc, "login-reset-offer"));
    check("Sign-in fields are the thing on show", shown(doc, "login-fields"));
    window.close();
  }
  {
    const { window } = boot(SITE, { session: true }), doc = window.document;
    await wait(700);
    check("An existing session still signs straight in", signedIn(doc));
    window.close();
  }

  console.log("\n-- Errors arriving as a query string are read too, not just the hash --");
  {
    const { window } = boot(SITE + "?error=access_denied&error_code=otp_expired"), doc = window.document;
    await wait(700);
    check("Query-string error is caught", /already opened|no longer valid|scanner/i.test(msgOf(doc)), msgOf(doc));
    window.close();
  }

  console.log("\n-- An unrecognised error still says something useful --");
  {
    const { window } = boot(SITE + "#error=server_error&error_description=Something+went+wrong+upstream"), doc = window.document;
    await wait(700);
    check("Falls back to the description Supabase sent",
      /Something went wrong upstream/i.test(msgOf(doc)), msgOf(doc));
    check("Plus signs are decoded back to spaces", msgOf(doc).indexOf("+") < 0, msgOf(doc));
    window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
