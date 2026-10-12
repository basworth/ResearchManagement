// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Admins get an Invite box in Settings that calls the server function with their own access
// token. The app never holds the privileged key; the function decides who may invite.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ADAM = "aaaaaaaa-0000-0000-0000-000000000001";
const RA = "bbbbbbbb-0000-0000-0000-000000000002";
const prof = (id, name, admin) => ({ id, kind: "profile", data: { id, email: name.toLowerCase().replace(/ /g, ".") + "@rushortho.com", name, position: "Research assistant", reportsTo: "", admin: !!admin }, updated_at: now });
const mockItems = [
  prof(ADAM, "Adam Yanke", true),
  prof(RA, "Some Assistant", false),
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke", "Some Assistant"], degrees: {} }, updated_at: now }
];

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
let lastFetch = null, fetchReply = { ok: true, message: "Invite sent to new@rushortho.com." }, fetchStatus = 200;
function build(asId) {
  return new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.fetch = async (url, opts) => {
        // Settings also asks the same function for the outstanding-invites list on every render,
        // so record only the calls that actually send an invite (those carry no `action`) —
        // otherwise the housekeeping call overwrites what this test is inspecting.
        let body = {};
        try { body = JSON.parse(opts.body); } catch (e) {}
        if (!body.action) lastFetch = { url: String(url), opts };
        if (body.action === "pending") {
          return { ok: true, status: 200, json: async () => ({ ok: true, pending: [], active: [] }), text: async () => "{}" };
        }
        return { ok: fetchStatus < 400, status: fetchStatus, json: async () => fetchReply, text: async () => JSON.stringify(fetchReply) };
      };
      win.supabase = { createClient: () => {
        const c = makeMockSupabase({ items: mockItems });
        const u = mockItems.find(r => r.id === asId);
        const session = { user: { id: asId, email: u.data.email }, access_token: "TOKEN-FOR-" + asId };
        c.auth.getSession = async () => ({ data: { session }, error: null });
        return c;
      } };
    }
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const d = build(ADAM), doc = d.window.document, w = d.window;
  await wait(450);
  w.eval('syncOnline = true; tab = "settings"; render();');
  await wait(150);

  console.log("\n-- Admins see the invite box --");
  check("Email field present", !!doc.getElementById("invite-email"));
  check("Invite button present", !!doc.getElementById("invite-send"));
  check("It explains the server-side check, and that a code is sent rather than a link",
    doc.getElementById("main").innerHTML.includes("checks you're an admin"));

  console.log("\n-- Empty input is refused before any request --");
  lastFetch = null;
  doc.getElementById("invite-send").click();
  await wait(120);
  check("No request was made", lastFetch === null);
  check("...and it says why", /enter an email/i.test(doc.getElementById("invite-msg").textContent),
    doc.getElementById("invite-msg").textContent);

  console.log("\n-- A real invite calls the function correctly --");
  doc.getElementById("invite-email").value = "new@rushortho.com";
  doc.getElementById("invite-send").click();
  await wait(200);
  check("It hit the invite-user function", lastFetch && /\/functions\/v1\/invite-user$/.test(lastFetch.url), lastFetch && lastFetch.url);
  check("...by POST", lastFetch.opts.method === "POST");
  check("...carrying the caller's own token", lastFetch.opts.headers.Authorization === "Bearer TOKEN-FOR-" + ADAM,
    lastFetch.opts.headers.Authorization);
  check("...with the email in the body", JSON.parse(lastFetch.opts.body).email === "new@rushortho.com");
  check("Success message shown", /invite sent/i.test(doc.getElementById("invite-msg").textContent));
  check("...and the field cleared for the next one", doc.getElementById("invite-email").value === "");

  console.log("\n-- The privileged key is never in the app --");
  check("No service_role key anywhere in the source", !/service_role/i.test(html));
  check("No SUPABASE_SERVICE_ROLE_KEY in the source", !html.includes("SUPABASE_SERVICE_ROLE_KEY"));

  console.log("\n-- Server rejections surface honestly --");
  fetchStatus = 403; fetchReply = { error: "Only admins can invite people" };
  doc.getElementById("invite-email").value = "someone@rushortho.com";
  doc.getElementById("invite-send").click();
  await wait(200);
  check("The server's refusal is shown", /only admins/i.test(doc.getElementById("invite-msg").textContent),
    doc.getElementById("invite-msg").textContent);
  check("...and the button is usable again", doc.getElementById("invite-send").disabled === false);
  check("...and the address is kept so it isn't retyped", doc.getElementById("invite-email").value === "someone@rushortho.com");

  console.log("\n-- Already-active accounts are reported, not re-invited --");
  fetchStatus = 200; fetchReply = { ok: false, alreadyActive: true, message: "x@rushortho.com already has an active account." };
  doc.getElementById("invite-email").value = "x@rushortho.com";
  doc.getElementById("invite-send").click();
  await wait(200);
  check("It says they already have one", /already has an active account/i.test(doc.getElementById("invite-msg").textContent));

  console.log("\n-- Non-admins don't get the box at all --");
  const d2 = build(RA);
  await wait(450);
  d2.window.eval('syncOnline = true; tab = "settings"; render();');
  await wait(150);
  check("No invite field for a non-admin", !d2.window.document.getElementById("invite-email"));
  check("No invite button either", !d2.window.document.getElementById("invite-send"));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
