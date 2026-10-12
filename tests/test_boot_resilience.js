// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// The app can't start at all without the Supabase library, so loading it from one CDN made a
// third party a single point of failure for the whole tracker — and on a hospital network any
// given host may be blocked or throttled. It now falls through several, and a connection
// failure no longer reads as "you've been signed out".
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

// `behaviour(url)` decides what each CDN does: "ok", "error", or "stall".
// `storedSession` seeds a Supabase auth token so the app believes it was signed in.
function boot(opts) {
  opts = opts || {};
  const attempts = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "https://rushsportsresearch.netlify.app/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      if (opts.storedSession) {
        win.localStorage.setItem("sb-wqgiqiqatdmoxpjbzxoj-auth-token", JSON.stringify({ access_token: "x" }));
      }
      // Stand in for the network: intercept the <script> the loader appends. Patched on the
      // prototype because document.head doesn't exist yet at beforeParse time.
      const realAppend = win.HTMLHeadElement.prototype.appendChild;
      win.HTMLHeadElement.prototype.appendChild = function (node) {
        if (node && node.tagName === "SCRIPT" && /supabase/i.test(node.src || "")) {
          attempts.push(node.src);
          const verdict = opts.behaviour ? opts.behaviour(node.src) : "ok";
          if (verdict === "ok") {
            win.supabase = { createClient: () => {
              const c = makeMockSupabase({ items: mockItems });
              if (opts.sessionError) c.auth.getSession = async () => { throw opts.sessionError; };
              return c;
            } };
            setTimeout(() => node.onload && node.onload(), 5);
          } else if (verdict === "error") {
            setTimeout(() => node.onerror && node.onerror(new win.Event("error")), 5);
          }
          // "stall": deliberately never call either, so the per-attempt deadline has to fire.
          return node;
        }
        return realAppend.call(this, node);
      };
    }
  });
  return { dom, attempts };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const msgOf = doc => (doc.getElementById("login-msg") || {}).textContent || "";
const host = u => { try { return new URL(u).host; } catch (e) { return u; } };

(async () => {
  console.log("\n-- Normally the first CDN is the only one touched --");
  {
    const { dom, attempts } = boot({ behaviour: () => "ok" });
    const { window } = dom, doc = window.document;
    await wait(800);
    check("Exactly one attempt", attempts.length === 1, attempts.map(host));
    check("...to jsdelivr", /jsdelivr/.test(attempts[0]), attempts[0]);
    check("The app signs in", doc.body.classList.contains("authed"));
    check("No error shown", msgOf(doc).trim() === "", msgOf(doc));
    window.close();
  }

  console.log("\n-- A blocked first CDN falls through to the second --");
  {
    const { dom, attempts } = boot({ behaviour: (u) => /jsdelivr/.test(u) ? "error" : "ok" });
    const { window } = dom, doc = window.document;
    await wait(900);
    check("Two attempts made", attempts.length === 2, attempts.map(host));
    check("Second is a different host", host(attempts[0]) !== host(attempts[1]), attempts.map(host));
    check("The app still boots", doc.body.classList.contains("authed"));
    check("...with no error shown to the user", msgOf(doc).trim() === "", msgOf(doc));
    window.close();
  }

  console.log("\n-- Two blocked CDNs still leave a third --");
  {
    const { dom, attempts } = boot({ behaviour: (u) => /cdnjs/.test(u) ? "ok" : "error" });
    const { window } = dom, doc = window.document;
    await wait(1200);
    check("Three attempts made", attempts.length === 3, attempts.map(host));
    check("All three hosts are distinct",
      new Set(attempts.map(host)).size === 3, attempts.map(host));
    check("The app still boots", doc.body.classList.contains("authed"));
    window.close();
  }

  console.log("\n-- A host that accepts then stalls doesn't hang the boot forever --");
  {
    // A throttling proxy never fires onerror, so only a deadline saves us. The deadline is 8s,
    // so this test just confirms the stalling host doesn't end the sequence.
    const { dom, attempts } = boot({ behaviour: (u) => /jsdelivr/.test(u) ? "stall" : "ok" });
    const { window } = dom;
    await wait(1500);
    check("Still waiting on the stalled host rather than giving up", attempts.length === 1, attempts.map(host));
    check("...and hasn't declared failure yet", msgOf(window.document).indexOf("Could not reach") < 0, msgOf(window.document));
    window.close();
  }

  console.log("\n-- Every CDN down: the message depends on whether you were signed in --");
  {
    const { dom, attempts } = boot({ behaviour: () => "error", storedSession: true });
    const { window } = dom, doc = window.document;
    await wait(1500);
    check("All three tried before giving up", attempts.length === 3, attempts.map(host));
    const msg = msgOf(doc);
    check("Says you're still signed in", /still signed in/i.test(msg), msg);
    check("...and not to bother signing in again", /no need to sign in again/i.test(msg), msg);
    check("...and that it retries by itself", /retrying/i.test(msg), msg);
    check("Doesn't claim the login is gone", !/Check your connection/i.test(msg), msg);
    window.close();
  }
  {
    const { dom } = boot({ behaviour: () => "error", storedSession: false });
    const { window } = dom, doc = window.document;
    await wait(1500);
    const msg = msgOf(doc);
    check("With no saved session, the plain connection message is right",
      /Could not reach the server/i.test(msg), msg);
    check("...and it doesn't wrongly claim you're signed in", !/still signed in/i.test(msg), msg);
    window.close();
  }

  console.log("\n-- The sign-in form stays available either way, so nobody is trapped --");
  {
    const { dom } = boot({ behaviour: () => "error", storedSession: true });
    const { window } = dom, doc = window.document;
    await wait(1500);
    const fields = doc.getElementById("login-fields");
    check("Email and password are still reachable", !!fields && fields.style.display !== "none");
    check("Not left in the app as a half-signed-in ghost", !doc.body.classList.contains("authed"));
    window.close();
  }

  console.log("\n-- hasStoredSession reads the real Supabase key shape --");
  {
    const { dom } = boot({ behaviour: () => "ok" });
    const { window } = dom;
    await wait(800);
    check("A genuine sb-<ref>-auth-token counts", window.eval(`(function(){
      localStorage.setItem("sb-abc123-auth-token", "{}");
      var r = hasStoredSession();
      localStorage.removeItem("sb-abc123-auth-token");
      return r;
    })()`) === true);
    check("An unrelated key doesn't", window.eval(`(function(){
      localStorage.setItem("sb-abc123-something-else", "{}");
      var r = hasStoredSession();
      localStorage.removeItem("sb-abc123-something-else");
      return r;
    })()`) === false);
    check("An empty value doesn't", window.eval(`(function(){
      localStorage.setItem("sb-abc123-auth-token", "");
      var r = hasStoredSession();
      localStorage.removeItem("sb-abc123-auth-token");
      return r;
    })()`) === false);
    window.close();
  }


  console.log("\n-- A genuinely dead refresh token says so, but never destroys anything --");
  {
    const { dom } = boot({
      behaviour: () => "ok", storedSession: true,
      sessionError: Object.assign(new Error("Invalid Refresh Token: Refresh Token Not Found"), { name: "AuthApiError" })
    });
    const { window } = dom, doc = window.document;
    await wait(900);
    const msg = msgOf(doc);
    check("Says the session expired", /session expired/i.test(msg), msg);
    check("...and asks them to sign in", /sign in again/i.test(msg), msg);
    check("...pointing at the code route if the password fails", /Forgot password/i.test(msg), msg);
    check("Does NOT claim they're still signed in", !/still signed in/i.test(msg), msg);
    // The regression this replaces: deleting the token turned one bad request into a permanent
    // sign-out. Signing in overwrites it anyway, so there was never a reason to remove it.
    check("The stored token is LEFT ALONE", window.eval("hasStoredSession()") === true);
    check("The sign-in form is there to use", doc.getElementById("login-fields").style.display !== "none");
    window.close();
  }

  console.log("\n-- A rotated refresh token is a race, not an expiry --");
  {
    // Supabase rotates refresh tokens; a reload mid-refresh, or a second tab, replays a rotated
    // one. Treating that as a dead session was logging people out day to day.
    const { dom } = boot({
      behaviour: () => "ok", storedSession: true,
      sessionError: Object.assign(new Error("Invalid Refresh Token: Already Used"), { name: "AuthApiError" })
    });
    const { window } = dom, doc = window.document;
    await wait(900);
    const msg = msgOf(doc);
    check("Not treated as an expiry", !/session expired/i.test(msg), msg);
    check("Reassures them instead", /still signed in/i.test(msg), msg);
    check("Token kept", window.eval("hasStoredSession()") === true);
    window.close();
  }

  console.log("\n-- A transient auth-service error is not a sign-out either --");
  {
    // A 5xx or rate-limit from the auth service used to match the old broad classifier.
    const { dom } = boot({
      behaviour: () => "ok", storedSession: true,
      sessionError: Object.assign(new Error("request to auth service failed with 503"), { name: "AuthApiError" })
    });
    const { window } = dom, doc = window.document;
    await wait(900);
    check("Reads as a connection problem", /still signed in/i.test(msgOf(doc)), msgOf(doc));
    check("Token kept", window.eval("hasStoredSession()") === true);
    window.close();
  }

  console.log("\n-- Every failure path keeps retrying --");
  {
    const { dom } = boot({
      behaviour: () => "ok", storedSession: true,
      sessionError: Object.assign(new Error("Invalid Refresh Token: Refresh Token Not Found"), { name: "AuthApiError" })
    });
    const { window } = dom;
    await wait(900);
    check("A retry is scheduled even for a dead session, so recovery is possible",
      window.eval("reconnectTimer !== null"));
    window.close();
  }

  console.log("\n-- A slow server is still treated as a network problem, not a sign-out --");
  {
    const { dom } = boot({
      behaviour: () => "ok", storedSession: true,
      sessionError: new Error("Checking session timed out")
    });
    const { window } = dom, doc = window.document;
    await wait(900);
    const msg = msgOf(doc);
    check("Still reassures them they're signed in", /still signed in/i.test(msg), msg);
    check("...and keeps the saved token", window.eval("hasStoredSession()") === true);
    window.close();
  }

  console.log("\n-- The CDN fallback chain gets long enough to actually finish --");
  {
    // Three attempts at 8s each need more than the old 12s outer deadline, which would have
    // killed the fallback before the second host was even tried.
    const { dom } = boot({ behaviour: () => "ok" });
    const { window } = dom;
    await wait(700);
    const urls = JSON.parse(window.eval("JSON.stringify(SUPABASE_LIB_URLS)"));
    check("Three hosts configured", urls.length === 3, urls);
    check("The outer boot deadline exceeds 3 x 8s",
      window.eval('bootApp.toString().indexOf("30000") > 0'));
    window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
