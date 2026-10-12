// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Rush's mail scanner opens one-time links before the recipient does, spending the token. So
// invites and resets now lead with a typed code, which nothing can consume in transit.
// These tests drive the code screen: sending, verifying, wrong codes, expiry, and the fact that
// a code lands you on the password box exactly like a healthy link would.
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

// `otp` describes the fake server: which code is right, and which link type accepts it.
function boot(opts) {
  opts = opts || {};
  const calls = { reset: [], verify: [] };
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: opts.url || "https://rushsportsresearch.netlify.app/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => {
        const client = makeMockSupabase({ items: mockItems });
        client.auth.getSession = async () => ({ data: { session: null }, error: null });
        client.auth.resetPasswordForEmail = async (email) => {
          calls.reset.push(email);
          if (opts.sendFails) return { data: null, error: { message: "Error sending recovery email" } };
          return { data: {}, error: null };
        };
        client.auth.verifyOtp = async ({ email, token, type }) => {
          calls.verify.push({ email, token, type });
          if (opts.deadCode) return { data: null, error: { message: "Token has expired or is invalid" } };
          if (opts.usedCode) return { data: null, error: { message: "Email link is invalid or has already been used" } };
          if (token !== (opts.goodCode || "123456")) {
            return { data: null, error: { message: opts.expired ? "Token has expired" : "Token has expired or is invalid" } };
          }
          if (type !== (opts.acceptType || "recovery")) {
            return { data: null, error: { message: "Token has expired or is invalid" } };
          }
          return { data: { session: { user: { id: "u1", email } } }, error: null };
        };
        client.auth.updateUser = async () => ({ data: {}, error: null });
        // The reset offer is meant to appear only after a real wrong-password attempt, so the
        // fake server has to actually reject one.
        client.auth.signInWithPassword = async () => ({ data: null, error: { message: "Invalid login credentials" } });
        return client;
      } };
    }
  });
  return { dom, calls };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const msgOf = doc => (doc.getElementById("login-msg") || {}).textContent || "";
const shown = (doc, id) => { const el = doc.getElementById(id); return !!el && el.style.display !== "none"; };
function setVal(doc, win, id, v) {
  const el = doc.getElementById(id);
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
  setter.call(el, v);
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
}

(async () => {
  console.log("\n-- Asking for a code takes you to the code box, not a 'check your email' dead end --");
  {
    const { dom, calls } = boot(), { window } = dom, doc = window.document;
    await wait(700);
    setVal(doc, window, "login-email", "carolina_habobanebel@rush.edu");
    doc.getElementById("login-forgot").click();
    await wait(400);
    check("The reset was actually requested", calls.reset.length === 1 && calls.reset[0] === "carolina_habobanebel@rush.edu", calls.reset);
    check("Code box is on show", shown(doc, "login-code"));
    check("Sign-in fields step aside", !shown(doc, "login-fields"));
    check("Password box stays hidden until the code checks out", !shown(doc, "login-recovery"));
    check("The prompt names the address it went to",
      doc.getElementById("code-intro").textContent.includes("carolina_habobanebel@rush.edu"),
      doc.getElementById("code-intro").textContent);
    check("...and mentions the junk folder, since that's the usual culprit",
      /junk/i.test(doc.getElementById("code-intro").textContent));
    window.close();
  }

  console.log("\n-- A good code opens the password box --");
  {
    const { dom, calls } = boot(), { window } = dom, doc = window.document;
    await wait(700);
    setVal(doc, window, "login-email", "carolina_habobanebel@rush.edu");
    doc.getElementById("login-forgot").click();
    await wait(300);
    setVal(doc, window, "login-code-input", "123456");
    doc.getElementById("login-code-submit").click();
    await wait(500);
    check("Password box now shown", shown(doc, "login-recovery"));
    check("Code box put away", !shown(doc, "login-code"));
    check("No error left on screen", msgOf(doc).trim() === "", msgOf(doc));
    check("Wording is the reset one, not the welcome one",
      /new password/i.test(doc.getElementById("recovery-intro").textContent),
      doc.getElementById("recovery-intro").textContent);
    check("Recovery was tried first, so the common case costs one round trip",
      calls.verify[0] && calls.verify[0].type === "recovery", calls.verify);
    window.close();
  }

  console.log("\n-- Spaces and dashes in a pasted code are forgiven --");
  {
    const { dom, calls } = boot(), { window } = dom, doc = window.document;
    await wait(700);
    setVal(doc, window, "login-email", "a@b.com");
    doc.getElementById("login-forgot").click();
    await wait(300);
    setVal(doc, window, "login-code-input", " 123 456 ");
    doc.getElementById("login-code-submit").click();
    await wait(500);
    check("Whitespace stripped before sending", calls.verify.some(v => v.token === "123456"), calls.verify);
    check("Password box reached", shown(doc, "login-recovery"));
    window.close();
  }

  console.log("\n-- An invited person's code works without being asked what kind of email they got --");
  {
    const { dom, calls } = boot({ acceptType: "invite" }), { window } = dom, doc = window.document;
    await wait(700);
    setVal(doc, window, "login-email", "matthew.kao@rushortho.com");
    // They already hold a code from the invite, so they shouldn't have to request another.
    doc.getElementById("login-forgot").click();
    await wait(300);
    showBack(doc);
    function showBack(d) { d.getElementById("login-code-back").click(); }
    await wait(200);
    check("Back returns to sign in", shown(doc, "login-fields"));
    doc.getElementById("login-forgot").click();
    await wait(300);
    setVal(doc, window, "login-code-input", "123456");
    doc.getElementById("login-code-submit").click();
    await wait(700);
    check("Falls through to the invite type and succeeds", shown(doc, "login-recovery"));
    check("...and greets them as someone new",
      /Welcome/i.test(doc.getElementById("recovery-intro").textContent),
      doc.getElementById("recovery-intro").textContent);
    check("Recovery was attempted before invite", calls.verify.map(v => v.type).indexOf("recovery") === 0, calls.verify.map(v => v.type));
    window.close();
  }

  console.log("\n-- 'I already have a code' skips straight to the box without burning the code --");
  {
    const { dom, calls } = boot(), { window } = dom, doc = window.document;
    await wait(700);
    setVal(doc, window, "login-email", "thomas.vega@rushortho.com");
    // The offer only appears after a failed sign-in, so reveal it the way a real user would.
    setVal(doc, window, "login-password", "wrong-password");
    doc.getElementById("login-submit").click();
    await wait(600);
    check("A failed sign-in surfaces the offer", shown(doc, "login-reset-offer"));
    doc.getElementById("login-have-code").click();
    await wait(300);
    check("Code box opens", shown(doc, "login-code"));
    check("No new email was sent", calls.reset.length === 0, calls.reset);
    setVal(doc, window, "login-code-input", "123456");
    doc.getElementById("login-code-submit").click();
    await wait(500);
    check("The code they already had works", shown(doc, "login-recovery"));
    window.close();
  }

  console.log("\n-- Wrong and expired codes say which is which --");
  {
    const { dom } = boot(), { window } = dom, doc = window.document;
    await wait(700);
    setVal(doc, window, "login-email", "a@b.com");
    doc.getElementById("login-forgot").click();
    await wait(300);
    setVal(doc, window, "login-code-input", "999999");
    doc.getElementById("login-code-submit").click();
    await wait(700);
    check("Says the code didn't work", /didn't work/i.test(msgOf(doc)), msgOf(doc));
  check("...and names the superseded-code cause", /most recent code works/i.test(msgOf(doc)), msgOf(doc));
    check("Stays on the code box so they can retry", shown(doc, "login-code"));
    check("Doesn't pretend they're through", !shown(doc, "login-recovery"));
    window.close();
  }
  {
    const { dom } = boot({ expired: true }), { window } = dom, doc = window.document;
    await wait(700);
    setVal(doc, window, "login-email", "a@b.com");
    doc.getElementById("login-forgot").click();
    await wait(300);
    setVal(doc, window, "login-code-input", "999999");
    doc.getElementById("login-code-submit").click();
    await wait(700);
    // Supabase returns the same text for mistyped, expired and superseded, so one honest
    // message covers all three rather than guessing at which it was.
    check("An expired code gets the same honest message", /didn't work/i.test(msgOf(doc)), msgOf(doc));
    check("...mentioning the one-hour lifetime", /codes last an hour/i.test(msgOf(doc)), msgOf(doc));
    window.close();
  }

  console.log("\n-- Guard rails --");
  {
    const { dom, calls } = boot(), { window } = dom, doc = window.document;
    await wait(700);
    setVal(doc, window, "login-email", "a@b.com");
    doc.getElementById("login-forgot").click();
    await wait(300);
    setVal(doc, window, "login-code-input", "12");
    doc.getElementById("login-code-submit").click();
    await wait(400);
    check("A short code isn't sent to the server", calls.verify.length === 0, calls.verify);
    check("...and says what's needed", /sign-in code|the code/i.test(msgOf(doc)), msgOf(doc));
    doc.getElementById("login-code-resend").click();
    await wait(400);
    check("Resend asks for another email", calls.reset.length === 2, calls.reset);
    window.close();
  }
  {
    const { dom, calls } = boot({ sendFails: true }), { window } = dom, doc = window.document;
    await wait(700);
    setVal(doc, window, "login-email", "a@b.com");
    doc.getElementById("login-forgot").click();
    await wait(500);
    check("A failed send reports the reason instead of showing an empty code box",
      /Error sending recovery email/i.test(msgOf(doc)), msgOf(doc));
    check("...and doesn't strand them on the code screen", !shown(doc, "login-code"));
    window.close();
  }

  console.log("\n-- A dead link now points at the code, since that's the way through --");
  {
    const { dom } = boot({ url: "https://rushsportsresearch.netlify.app/#error=access_denied&error_code=otp_expired" });
    const { window } = dom, doc = window.document;
    await wait(700);
    check("Explains that something opened it first",
      /scanner|opened it first|already opened/i.test(msgOf(doc)), msgOf(doc));
    check("...and sends them to the code", /code/i.test(msgOf(doc)), msgOf(doc));
    check("The offer with both buttons is open", shown(doc, "login-reset-offer"));
    window.close();
  }


  console.log("\n-- A dead code stops after one attempt instead of burning the rate limit --");
  {
    const { dom, calls } = boot({ deadCode: true }), { window } = dom, doc = window.document;
    await wait(700);
    setVal(doc, window, "login-email", "a@b.com");
    doc.getElementById("login-forgot").click();
    await wait(300);
    setVal(doc, window, "login-code-input", "123456");
    doc.getElementById("login-code-submit").click();
    await wait(700);
    // The old loop tried recovery, invite, signup, magiclink and email — five requests for a code
    // that was already dead, then reported whichever error came last.
    // Was five (recovery, invite, signup, magiclink, email) for a code that was already dead.
    check("At most two verify attempts", calls.verify.length === 2, calls.verify.map(v => v.type));
    check("...recovery first, since that's what every code we send now is",
      calls.verify[0].type === "recovery");
    check("Explains that only the newest code works",
      /only the most recent code works/i.test(msgOf(doc)), msgOf(doc));
    window.close();
  }

  console.log("\n-- An already-used code says so plainly --");
  {
    const { dom, calls } = boot({ usedCode: true }), { window } = dom, doc = window.document;
    await wait(700);
    setVal(doc, window, "login-email", "a@b.com");
    doc.getElementById("login-forgot").click();
    await wait(300);
    setVal(doc, window, "login-code-input", "123456");
    doc.getElementById("login-code-submit").click();
    await wait(700);
    check("Says it didn't work", /didn't work/i.test(msgOf(doc)), msgOf(doc));
    check("...and points at Send a new code", /Send a new code/i.test(msgOf(doc)), msgOf(doc));
    check("Two attempts, not five", calls.verify.length === 2, calls.verify.map(v => v.type));
    window.close();
  }

  console.log("\n-- A wrong code still falls through to the invite type, but no further --");
  {
    // Wrong-code errors don't mention expiry, so the invite fallback is still worth one try for
    // anyone holding a code from before invites moved to the recovery template.
    const { dom, calls } = boot({ goodCode: "999999", acceptType: "invite" }), { window } = dom, doc = window.document;
    await wait(700);
    setVal(doc, window, "login-email", "a@b.com");
    doc.getElementById("login-forgot").click();
    await wait(300);
    // The RIGHT code, but issued as an invite — so recovery must fail and invite must succeed.
    setVal(doc, window, "login-code-input", "999999");
    doc.getElementById("login-code-submit").click();
    await wait(800);
    check("Tries recovery then invite, and stops", calls.verify.map(v => v.type).join(",") === "recovery,invite",
      calls.verify.map(v => v.type));
    check("The invite fallback still works for an old invite code", shown(doc, "login-recovery"));
    check("Doesn't try signup/magiclink/email at all",
      !calls.verify.some(v => ["signup", "magiclink", "email"].indexOf(v.type) >= 0),
      calls.verify.map(v => v.type));
    window.close();
  }

  console.log("\n-- 'I already have a code' warns about superseded codes up front --");
  {
    const { dom } = boot(), { window } = dom, doc = window.document;
    await wait(700);
    setVal(doc, window, "login-email", "a@b.com");
    setVal(doc, window, "login-password", "wrong");
    doc.getElementById("login-submit").click();
    await wait(600);
    doc.getElementById("login-have-code").click();
    await wait(250);
    const intro = doc.getElementById("code-intro").textContent;
    check("Tells them to use the most recent email", /MOST RECENT/i.test(intro), intro);
    check("...and that only the newest works", /only the newest one works/i.test(intro), intro);
    window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
