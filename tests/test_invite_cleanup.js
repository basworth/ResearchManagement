// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Tidying up after invites, three ways:
//   1. A waiting invite can be deleted. This is the one destructive action in the app, asked for
//      explicitly, and it's narrow: the server refuses unless the account has never signed in.
//   2. Each waiting invite says who it probably already is — Carla's open rush.edu invite next
//      to her live rushortho.com login is the case worth catching.
//   3. Once someone signs in they're in the org chart, so their roster name leaves TEAM MEMBERS.
//      Hidden, not deleted: state.roster is untouched and they stay assignable everywhere.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();

const ADAM = "11111111-1111-1111-1111-111111111111";
const CARLA = "22222222-2222-2222-2222-222222222222";
const WILL = "33333333-3333-3333-3333-333333333333";

const profile = (id, name, email, extra) => ({ id, kind: "profile", updated_at: now,
  data: Object.assign({ id, name, email, position: "", reportsTo: "", alertEmail: "", linkedTo: "", alertEmailAsked: true }, extra || {}) });

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

function boot(opts) {
  opts = opts || {};
  const roster = opts.roster || ["Adam Yanke", "Carla Edwards", "William Lee", "Cade Smelley"];
  const items = (opts.items || [
    profile(ADAM, "Adam Yanke", "adam.yanke@rushortho.com", { admin: true, position: "Clinician" }),
    profile(CARLA, "Carla Edwards", "carla.edwards@rushortho.com", { position: "Research manager (CRCM)", reportsTo: ADAM }),
    profile(WILL, "William Lee", "william.lee@rushortho.com", { position: "Research assistant", reportsTo: ADAM })
  ]).concat([{ id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
    data: { id: "00000000-0000-0000-0000-000000000001", names: roster, degrees: opts.degrees || {} } }]);
  const calls = [];
  const replies = opts.fnReplies || {};
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.fetch = async (url, o) => {
        let body = {};
        try { body = JSON.parse(o.body); } catch (e) {}
        calls.push(body);
        const r = replies[body.action || "invite"] || { ok: true, message: "Done." };
        return { ok: !r.error, status: r.error ? 409 : 200, json: async () => r };
      };
      win.supabase = { createClient: () => {
        const c = makeMockSupabase({ items });
        c.auth.getSession = async () => ({ data: { session: { access_token: "tok", user: { id: ADAM, email: "adam.yanke@rushortho.com" } } }, error: null });
        return c;
      } };
    }
  });
  return { dom, calls };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

async function settings(dom) {
  const { window } = dom;
  await wait(600);
  window.eval(`currentUser = { id: ${JSON.stringify(ADAM)}, email: "adam.yanke@rushortho.com" }; syncOnline = true;`);
  window.document.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
  await wait(60);
  window.eval(`tab = "settings"; render();`);
  await wait(400);
}

// Carla: invited at rush.edu, never signed in; already live at rushortho.com.
const CARLA_PENDING = {
  ok: true,
  pending: [{ id: "p1", email: "carla.edwards@rush.edu", invitedAt: new Date(Date.now() - 9 * 86400e3).toISOString(), codeSentAt: new Date(Date.now() - 9 * 86400e3).toISOString() }],
  active: [
    { id: ADAM, email: "adam.yanke@rushortho.com", name: "Adam Yanke", lastSignInAt: now },
    { id: CARLA, email: "carla.edwards@rushortho.com", name: "Carla Edwards", lastSignInAt: now }
  ]
};

(async () => {
  // ================================================================= the recommendation
  console.log("\n-- A waiting invite that's probably somebody already in --");
  {
    const { dom } = boot({ fnReplies: { pending: CARLA_PENDING } });
    const { window } = dom, doc = window.document;
    await settings(dom);
    await wait(300);
    const t = doc.getElementById("pending-invites").textContent;
    check("Names who it probably is", /Probably Carla Edwards/.test(t), t.slice(0, 260));
    check("...and the address she's already in from", t.indexOf("carla.edwards@rushortho.com") >= 0);
    check("...and recommends deleting the spare", /spare you can delete/i.test(t));
    window.close();
  }

  console.log("\n-- A genuinely new person gets no such claim --");
  {
    const { dom } = boot({ fnReplies: { pending: { ok: true,
      pending: [{ id: "p2", email: "ccs1724@jagmail.southalabama.edu", invitedAt: now, codeSentAt: now }],
      active: CARLA_PENDING.active } } });
    const { window } = dom, doc = window.document;
    await settings(dom);
    await wait(300);
    const t = doc.getElementById("pending-invites").textContent;
    check("It's listed", t.indexOf("ccs1724@jagmail") >= 0);
    check("...with no 'probably' claim attached", !/Probably/.test(t), t.slice(0, 200));
    window.close();
  }

  console.log("\n-- Falls back to local profiles if the server sends no list --");
  {
    const { dom } = boot({ fnReplies: { pending: { ok: true,
      pending: [{ id: "p1", email: "carla.edwards@rush.edu", invitedAt: now, codeSentAt: now }] } } });
    const { window } = dom, doc = window.document;
    await settings(dom);
    await wait(300);
    check("Still spots Carla", /Probably Carla Edwards/.test(doc.getElementById("pending-invites").textContent));
    window.close();
  }

  // ================================================================= deletion
  console.log("\n-- Deleting a waiting invite --");
  {
    const { dom, calls } = boot({ fnReplies: {
      pending: CARLA_PENDING,
      cancel: { ok: true, deleted: true, message: "Invite for carla.edwards@rush.edu deleted — that address is free to invite again." }
    } });
    const { window } = dom, doc = window.document;
    await settings(dom);
    await wait(300);
    const del = doc.querySelector("[data-invite-del]");
    check("There's a Delete button", !!del);
    check("...alongside Resend", !!doc.querySelector("[data-resend]"));
    del.click();
    await wait(300);
    const sheet = doc.getElementById("sheet");
    check("It asks first", !!sheet);
    check("...naming the address", sheet.textContent.indexOf("carla.edwards@rush.edu") >= 0);
    check("...saying who it looks like", /Carla Edwards/.test(sheet.textContent));
    check("...promising her live account is untouched", /won't touch that account/i.test(sheet.textContent));
    check("...explaining nothing is lost", /no name, no tasks and no studies/i.test(sheet.textContent));
    check("...and that the address is freed", /free/i.test(sheet.textContent));
    check("The button says Delete invite", doc.getElementById("sheet-save").textContent === "Delete invite",
      doc.getElementById("sheet-save").textContent);
    check("Nothing deleted yet", !calls.some(c => c.action === "cancel"), calls);

    doc.getElementById("sheet-save").click();
    await wait(400);
    check("Confirming deletes it", calls.some(c => c.action === "cancel" && c.email === "carla.edwards@rush.edu"), calls);
    check("...and says the address is free again",
      /free to invite again/i.test(doc.getElementById("toast").textContent), doc.getElementById("toast").textContent);
    window.close();
  }

  console.log("\n-- Backing out deletes nothing --");
  {
    const { dom, calls } = boot({ fnReplies: { pending: CARLA_PENDING } });
    const { window } = dom, doc = window.document;
    await settings(dom);
    await wait(300);
    doc.querySelector("[data-invite-del]").click();
    await wait(300);
    doc.getElementById("sheet-cancel").click();
    await wait(350);
    check("No delete call", !calls.some(c => c.action === "cancel"), calls);
    check("The invite is still listed",
      doc.getElementById("pending-invites").textContent.indexOf("carla.edwards@rush.edu") >= 0);
    window.close();
  }

  console.log("\n-- A refusal from the server is reported, not swallowed --");
  {
    const { dom } = boot({ fnReplies: {
      pending: CARLA_PENDING,
      cancel: { error: "carla.edwards@rush.edu has already signed in, so this won't delete them. Use the org chart if they've left." }
    } });
    const { window } = dom, doc = window.document;
    await settings(dom);
    await wait(300);
    doc.querySelector("[data-invite-del]").click();
    await wait(300);
    doc.getElementById("sheet-save").click();
    await wait(450);
    const msg = doc.getElementById("toast").textContent;
    check("The refusal is shown", /already signed in/i.test(msg), msg);
    check("...framed as a failure to delete", /Could not delete/i.test(msg), msg);
    window.close();
  }

  // ================================================================= the team list
  console.log("\n-- Signed-in people leave TEAM MEMBERS for the Org Chart --");
  {
    const { dom } = boot({ fnReplies: { pending: { ok: true, pending: [], active: [] } } });
    const { window } = dom, doc = window.document;
    await settings(dom);
    const left = JSON.parse(window.eval("JSON.stringify(rosterWithoutAccounts())"));
    check("Only the person with no account remains", left.join(",") === "Cade Smelley", left);
    check("Adam has an account", window.eval('hasSignedInAccount("Adam Yanke")') === true);
    check("Cade does not", window.eval('hasSignedInAccount("Cade Smelley")') === false);
    check("An unknown name does not", window.eval('hasSignedInAccount("Nobody At All")') === false);
    check("A blank name does not blow up", window.eval('hasSignedInAccount("")') === false);

    // The underlying data must be untouched — everything else in the app reads state.roster.
    check("state.roster still holds all four", window.eval("state.roster.length") === 4, window.eval("state.roster.length"));
    check("...including the ones who signed in", window.eval('state.roster.indexOf("Carla Edwards") >= 0'));

    // And the UI reflects it.
    const main = doc.getElementById("main").textContent;
    check("It explains where they went", /move to the Org Chart below and drop off this list/i.test(main));
    check("...and counts them", /3 people are in the Org Chart instead/.test(main), main.slice(main.indexOf("Org Chart instead") - 60, main.indexOf("Org Chart instead") + 20));
    check("The org chart still lists them", window.eval("orgChartHTML(true)").indexOf("Carla Edwards") >= 0);
    window.close();
  }

  console.log("\n-- Degrees stay reachable once someone leaves the team list --");
  {
    const { dom } = boot({ degrees: { "Carla Edwards": ["RN", "CCRC"] }, fnReplies: { pending: { ok: true, pending: [], active: [] } } });
    const { window } = dom, doc = window.document;
    await settings(dom);
    check("Carla is no longer in the team list", JSON.parse(window.eval("JSON.stringify(rosterWithoutAccounts())")).indexOf("Carla Edwards") < 0);
    const chart = window.eval("orgChartHTML(true)");
    check("...but the org chart offers her a Degrees button", chart.indexOf('data-degrees-for="Carla Edwards"') >= 0);
    check("...and shows what she already has", /RN, CCRC/.test(chart));
    // The button must actually be wired, not just rendered.
    const btn = [...doc.querySelectorAll('[data-degrees-for="Carla Edwards"]')].pop();
    check("The button exists in the page", !!btn);
    btn.click();
    await wait(300);
    check("...and opens the degrees editor", !!doc.getElementById("sheet") && /Carla Edwards/.test(doc.getElementById("sheet").textContent));
    window.close();
  }

  console.log("\n-- Degrees and aliases don't cause a false 'no account' --");
  {
    // The roster spelling carries degrees; the profile doesn't. canonName has to bridge that,
    // or "Adam Yanke, MD" would sit in the team list next to Adam Yanke in the chart.
    const { dom } = boot({ roster: ["Adam Yanke, MD", "Cade Smelley"], fnReplies: { pending: { ok: true, pending: [], active: [] } } });
    const { window } = dom;
    await settings(dom);
    check("The degree-suffixed spelling still matches his account",
      window.eval('hasSignedInAccount("Adam Yanke, MD")') === true);
    window.close();
  }

  console.log("\n-- A linked spare can't keep a name on the list --");
  {
    const CARLA2 = "44444444-4444-4444-4444-444444444444";
    const items = [
      profile(ADAM, "Adam Yanke", "adam.yanke@rushortho.com", { admin: true }),
      // Only account bearing this name is a linked spare, so nobody is really "in" under it.
      profile(CARLA2, "Nora Bell", "nora.bell@rush.edu", { linkedTo: ADAM })
    ];
    const { dom } = boot({ items, roster: ["Adam Yanke", "Nora Bell"], fnReplies: { pending: { ok: true, pending: [], active: [] } } });
    const { window } = dom;
    await settings(dom);
    check("The linked spare doesn't count as an account",
      window.eval('hasSignedInAccount("Nora Bell")') === false);
    check("...so the name stays visible in the team list",
      JSON.parse(window.eval("JSON.stringify(rosterWithoutAccounts())")).indexOf("Nora Bell") >= 0);
    window.close();
  }

  console.log("\n-- Everyone signed in reads as tidy, not empty --");
  {
    const { dom } = boot({ roster: ["Adam Yanke", "Carla Edwards", "William Lee"], fnReplies: { pending: { ok: true, pending: [], active: [] } } });
    const { window } = dom, doc = window.document;
    await settings(dom);
    check("No names left", JSON.parse(window.eval("JSON.stringify(rosterWithoutAccounts())")).length === 0);
    check("...and it says why rather than 'No members yet'",
      /Everyone on the team list has signed in/i.test(doc.getElementById("main").textContent));
    window.close();
  }

  console.log("\n-- Assignment and author lists are unaffected --");
  {
    const { dom } = boot({ fnReplies: { pending: { ok: true, pending: [], active: [] } } });
    const { window } = dom, doc = window.document;
    await settings(dom);
    // The datalist that feeds task assignment must still offer signed-in people.
    const dl = doc.getElementById("dl-people-set");
    check("The people datalist still includes signed-in members",
      !!dl && dl.innerHTML.indexOf("Carla Edwards") >= 0);
    check("...and the ones without accounts", dl.innerHTML.indexOf("Cade Smelley") >= 0);
    window.close();
  }

  // ================================================================= server side
  console.log("\n-- The server is what makes deletion safe --");
  {
    const fn = fs.readFileSync(PROJECT + "/supabase/functions/invite-user/index.ts", "utf8");
    check("A cancel action exists", fn.indexOf('action === "cancel"') > 0);
    check("It refuses anyone who has signed in", /last_sign_in_at[\s\S]{0,200}409/.test(fn));
    check("...judged from a fresh read, not the request body", /allAccounts\(admin\)[\s\S]{0,400}last_sign_in_at/.test(fn));
    check("It won't delete the caller's own account", /acct\.id === callerId/.test(fn));
    check("Admin is checked before it", fn.indexOf("Only admins can invite people") < fn.indexOf('action === "cancel"'));
    check("Deleting an already-gone address is a success, not an error", /already gone/.test(fn));
    check("The one destructive action is documented as deliberate", /explicit request/.test(fn));
    check("deleteUser is called exactly once in the file",
      (fn.match(/deleteUser/g) || []).length === 1, (fn.match(/deleteUser/g) || []).length);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
