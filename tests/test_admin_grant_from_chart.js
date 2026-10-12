// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Adam shouldn't have to ask himself for permission: he can tick Admin straight from the org
// chart. Everyone else still has to request it and wait. The tick box is UI only — the edge
// function checks the caller's verified token against its own approver secret, so the constant
// in the app can hide a control or show a dead one, never hand out real power.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();

const ADAM = "11111111-1111-1111-1111-111111111111";
const CARLA = "22222222-2222-2222-2222-222222222222";
const WILL = "33333333-3333-3333-3333-333333333333";

const profile = (id, name, email, extra) => ({ id, kind: "profile", updated_at: now,
  data: Object.assign({ id, name, email, position: "", reportsTo: "" }, extra || {}) });

const mockItems = [
  profile(ADAM, "Adam Yanke", "adam.yanke@rushortho.com", { admin: true, position: "Clinician" }),
  profile(CARLA, "Carla Edwards", "carla.edwards@rushortho.com", { position: "Research manager (CRCM)", reportsTo: ADAM }),
  profile(WILL, "William Lee", "william.lee@rushortho.com", { admin: true, position: "Research assistant", reportsTo: ADAM }),
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
    data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} } }
];

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

// `as` decides who is signed in. `fnReply` stands in for the edge function.
function boot(as, fnReply) {
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.fetch = async (url, opts) => {
        if (String(url).indexOf("/functions/v1/admin-requests") >= 0) {
          calls.push(JSON.parse(opts.body));
          const r = fnReply || { ok: true, message: "Done." };
          return { ok: !r.error, status: r.error ? 403 : 200, json: async () => r };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      };
      win.supabase = { createClient: () => {
        const c = makeMockSupabase({ items: mockItems });
        c.auth.getSession = async () => ({ data: { session: { access_token: "tok", user: { id: as.id, email: as.email } } }, error: null });
        return c;
      } };
    }
  });
  return { dom, calls };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

async function openSheetFor(window, doc, userId) {
  window.eval(`tab = "settings"; render();`);
  await wait(200);
  window.eval(`openOrgSheet(${JSON.stringify(userId)})`);
  await wait(250);
  return doc.getElementById("sheet");
}

(async () => {
  // ---------------------------------------------------------------- as Adam (the approver)
  console.log("\n-- Adam sees an Admin tick box on other people --");
  {
    const { dom, calls } = boot({ id: ADAM, email: "adam.yanke@rushortho.com" });
    const { window } = dom, doc = window.document;
    await wait(600);
    window.eval(`currentUser = { id: ${JSON.stringify(ADAM)}, email: "adam.yanke@rushortho.com" }; syncOnline = true;`);
    await wait(80);
    check("He is recognised as the approver", window.eval("amApprover()") === true);

    await openSheetFor(window, doc, CARLA);
    const box = doc.getElementById("f-org-admin");
    check("The tick box is there for Carla", !!box);
    check("...unticked, since she isn't an admin", box && box.checked === false);
    check("...and it explains that others must request", /Request admin access/i.test(doc.getElementById("sheet").innerHTML));

    // Tick it and save.
    box.checked = true;
    doc.getElementById("sheet-save").click();
    await wait(500);
    check("One call to the function", calls.length === 1, calls);
    check("...with action set", calls[0] && calls[0].action === "set", calls[0]);
    check("...naming Carla", calls[0] && calls[0].userId === CARLA, calls[0]);
    check("...and asking to grant", calls[0] && calls[0].admin === true, calls[0]);
    window.close();
  }

  console.log("\n-- Unticking revokes --");
  {
    const { dom, calls } = boot({ id: ADAM, email: "adam.yanke@rushortho.com" });
    const { window } = dom, doc = window.document;
    await wait(600);
    window.eval(`currentUser = { id: ${JSON.stringify(ADAM)}, email: "adam.yanke@rushortho.com" }; syncOnline = true;`);
    await wait(80);
    await openSheetFor(window, doc, WILL);
    const box = doc.getElementById("f-org-admin");
    check("Ticked for William, who is an admin", box && box.checked === true);
    check("...and warns what unticking does", /removes their access/i.test(doc.getElementById("sheet").innerHTML));
    box.checked = false;
    doc.getElementById("sheet-save").click();
    await wait(500);
    check("Asks to revoke", calls[0] && calls[0].admin === false, calls[0]);
    window.close();
  }

  console.log("\n-- Leaving the box alone doesn't call the function at all --");
  {
    const { dom, calls } = boot({ id: ADAM, email: "adam.yanke@rushortho.com" });
    const { window } = dom, doc = window.document;
    await wait(600);
    window.eval(`currentUser = { id: ${JSON.stringify(ADAM)}, email: "adam.yanke@rushortho.com" }; syncOnline = true;`);
    await wait(80);
    await openSheetFor(window, doc, CARLA);
    // Change only the role, not the tick box.
    doc.getElementById("f-org-pos").value = "Research manager (CRCM)";
    doc.getElementById("sheet-save").click();
    await wait(500);
    check("No admin call made", calls.length === 0, calls);
    check("...but the role still saved",
      window.eval(`(profileFor(${JSON.stringify(CARLA)}) || {}).position`) === "Research manager (CRCM)",
      window.eval(`(profileFor(${JSON.stringify(CARLA)}) || {}).position`));
    window.close();
  }

  console.log("\n-- Adam can't remove his own admin rights from here --");
  {
    const { dom } = boot({ id: ADAM, email: "adam.yanke@rushortho.com" });
    const { window } = dom, doc = window.document;
    await wait(600);
    window.eval(`currentUser = { id: ${JSON.stringify(ADAM)}, email: "adam.yanke@rushortho.com" }; syncOnline = true;`);
    await wait(80);
    await openSheetFor(window, doc, ADAM);
    check("No tick box on his own row", !doc.getElementById("f-org-admin"));
    check("...and it says why", /This is you/i.test(doc.getElementById("sheet").innerHTML),
      doc.getElementById("sheet").innerHTML.indexOf("This is you"));
    check("...mentioning there'd be no way back", /no way to grant them back/i.test(doc.getElementById("sheet").innerHTML));
    window.close();
  }

  // ---------------------------------------------------------------- as another admin
  console.log("\n-- Another admin gets no tick box, only the request route --");
  {
    const { dom, calls } = boot({ id: WILL, email: "william.lee@rushortho.com" });
    const { window } = dom, doc = window.document;
    await wait(600);
    window.eval(`currentUser = { id: ${JSON.stringify(WILL)}, email: "william.lee@rushortho.com" }; syncOnline = true;`);
    await wait(80);
    check("William is NOT the approver", window.eval("amApprover()") === false);

    // He IS an admin, so he can still edit the chart itself.
    await openSheetFor(window, doc, CARLA);
    check("He can still open the sheet", !!doc.getElementById("sheet"));
    check("Role and reporting are still editable", !!doc.getElementById("f-org-pos") && !!doc.getElementById("f-org-boss"));
    check("But there's no Admin tick box", !doc.getElementById("f-org-admin"));
    check("...and it says only Adam can change it",
      /Only Adam can change that|requesting it and Adam approving|Adam granting it/i.test(doc.getElementById("sheet").innerHTML));
    doc.getElementById("sheet-save").click();
    await wait(400);
    check("Saving makes no admin call", calls.length === 0, calls);
    window.close();
  }

  console.log("\n-- A refusal from the server is reported, not swallowed --");
  {
    const { dom, calls } = boot({ id: ADAM, email: "adam.yanke@rushortho.com" },
      { error: "Only Adam can grant admin rights. Use \"Request admin access\" instead." });
    const { window } = dom, doc = window.document;
    await wait(600);
    window.eval(`currentUser = { id: ${JSON.stringify(ADAM)}, email: "adam.yanke@rushortho.com" }; syncOnline = true;`);
    await wait(80);
    await openSheetFor(window, doc, CARLA);
    doc.getElementById("f-org-admin").checked = true;
    doc.getElementById("sheet-save").click();
    await wait(600);
    check("The call was attempted", calls.length === 1, calls);
    // The role save already succeeded and was toasted, so the failure has to speak for itself.
    check("The failure surfaces as its own message",
      /Could not grant admin/i.test(doc.getElementById("toast").textContent),
      doc.getElementById("toast").textContent);
    check("Carla is NOT shown as an admin locally",
      window.eval(`(profileFor(${JSON.stringify(CARLA)}) || {}).admin`) !== true);
    window.close();
  }


  console.log("\n-- If the server hasn't caught up, the box says so instead of failing cryptically --");
  {
    const { dom, calls } = boot({ id: ADAM, email: "adam.yanke@rushortho.com" },
      { error: "Unknown action" });
    const { window } = dom, doc = window.document;
    await wait(600);
    window.eval(`currentUser = { id: ${JSON.stringify(ADAM)}, email: "adam.yanke@rushortho.com" }; syncOnline = true;`);
    await wait(80);
    await openSheetFor(window, doc, CARLA);
    doc.getElementById("f-org-admin").checked = true;
    doc.getElementById("sheet-save").click();
    await wait(600);
    check("It was attempted", calls.length === 1, calls);
    // Read the toast, not body.innerHTML — the app's whole source lives in an inline <script>
    // inside <body>, so a naive search matches the code as well as the message.
    const msg = doc.getElementById("toast").textContent;
    check("Explains the server is behind", /hasn't picked up this feature yet/i.test(msg), msg);
    check("...points at the working route meanwhile", /Request admin access/i.test(msg), msg);
    check("...and doesn't leak the raw error", !/Unknown action/.test(msg), msg);
    window.close();
  }

  console.log("\n-- The server is the real gate, whatever the app thinks --");
  {
    const fn = fs.readFileSync(PROJECT + "/supabase/functions/admin-requests/index.ts", "utf8");
    check("The set action exists", fn.indexOf('action === "set"') > 0);
    check("...and refuses anyone but the approver", /callerEmail !== APPROVER[\s\S]{0,220}403/.test(fn));
    check("...checked against the verified token, not the request body",
      fn.indexOf("who.user.email.toLowerCase()") > 0);
    check("...and refuses self-revocation server-side too",
      /userId === callerId && !makeAdmin/.test(fn));
    check("It closes any open request so nobody gets stuck", /admin_requests[\s\S]{0,200}status", "pending"/.test(fn));
    check("The app constant is documented as cosmetic",
      html.indexOf("it can't hand anybody real power") > 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
