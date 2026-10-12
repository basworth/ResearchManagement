// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// After a wrong-password attempt the login screen should offer to email a reset link, because
// Supabase returns the same generic "Invalid login credentials" whether the password is wrong
// or was never set — and "never set" is the common case for someone who was invited.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

// Drive auth outcomes from the test rather than the mock's defaults.
let signInError = null, resetCalls = [], resetError = null;
function build() {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => {
        const c = makeMockSupabase({ items: [] });
        c.auth.signInWithPassword = async () => ({ data: {}, error: signInError });
        c.auth.resetPasswordForEmail = async (email, opts) => {
          resetCalls.push({ email, opts });
          return { data: {}, error: resetError };
        };
        c.auth.getSession = async () => ({ data: { session: null }, error: null });
        return c;
      } };
    }
  });
  return dom;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const dom = build();
  const { window } = dom, doc = window.document;
  await wait(400);

  const offer = doc.getElementById("login-reset-offer");
  const msg = doc.getElementById("login-msg");
  check("The reset offer exists in the markup", !!offer);
  check("...and starts hidden", offer.style.display === "none", offer.style.display);

  console.log("\n-- Wrong password surfaces the offer --");
  signInError = { message: "Invalid login credentials" };
  doc.getElementById("login-email").value = "william.lee@rushortho.com";
  doc.getElementById("login-password").value = "wrongpass";
  doc.getElementById("login-submit").click();
  await wait(150);
  check("The offer is now visible", offer.style.display === "block", offer.style.display);
  check("...with a plain-language message", /don't match/i.test(msg.textContent), msg.textContent);
  check("...that doesn't parrot the raw API error", !/invalid login credentials/i.test(msg.textContent));
  check("...and explains the 'never set a password' case",
    /never set a password/i.test(offer.textContent), offer.textContent.slice(0, 120));

  console.log("\n-- Tapping it sends a reset to the email already typed --");
  resetCalls = [];
  doc.getElementById("login-reset-send").click();
  await wait(150);
  check("A reset was requested", resetCalls.length === 1, resetCalls);
  check("...to the right address", resetCalls[0] && resetCalls[0].email === "william.lee@rushortho.com");
  check("...redirecting back to this app, not localhost:3000",
    resetCalls[0] && resetCalls[0].opts && resetCalls[0].opts.redirectTo === "http://localhost",
    resetCalls[0] && resetCalls[0].opts);
  check("The offer collapses once sent", offer.style.display === "none");
  // Sending now hands straight over to the code box rather than telling them to go hunt for a
  // link — Rush's scanner spends links before people reach them, so codes are the way in.
  check("...and opens the code box", doc.getElementById("login-code").style.display === "block",
    doc.getElementById("login-code").style.display);
  check("...naming the address it went to",
    /william\.lee@rushortho\.com/.test(doc.getElementById("code-intro").textContent),
    doc.getElementById("code-intro").textContent);
  check("...and the sign-in fields step aside",
    doc.getElementById("login-fields").style.display === "none");

  console.log("\n-- Retrying hides the offer again --");
  signInError = { message: "Invalid login credentials" };
  doc.getElementById("login-submit").click();
  await wait(150);
  check("Offer reappears on another failure", offer.style.display === "block");
  signInError = null;
  doc.getElementById("login-submit").click();
  await wait(150);
  check("A fresh attempt clears the offer first", offer.style.display === "none");

  console.log("\n-- Other errors are shown verbatim, no reset offer --");
  const d2 = build(); const w2 = d2.window, doc2 = w2.document;
  await wait(400);
  signInError = { message: "Email logins are disabled" };
  doc2.getElementById("login-email").value = "someone@rushortho.com";
  doc2.getElementById("login-password").value = "x";
  doc2.getElementById("login-submit").click();
  await wait(150);
  check("Unrelated error text is passed through",
    /email logins are disabled/i.test(doc2.getElementById("login-msg").textContent));
  check("...and no reset offer appears",
    doc2.getElementById("login-reset-offer").style.display === "none");

  console.log("\n-- A failed send reports the problem --");
  const d3 = build(); const doc3 = d3.window.document;
  await wait(400);
  signInError = { message: "Invalid login credentials" };
  doc3.getElementById("login-email").value = "a@b.com";
  doc3.getElementById("login-password").value = "x";
  doc3.getElementById("login-submit").click();
  await wait(150);
  resetError = { message: "Email rate limit exceeded" };
  doc3.getElementById("login-reset-send").click();
  await wait(150);
  check("Send failure is surfaced", /rate limit/i.test(doc3.getElementById("login-msg").textContent),
    doc3.getElementById("login-msg").textContent);
  check("...and the button is re-enabled to try again",
    doc3.getElementById("login-reset-send").disabled === false);
  resetError = null;

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
