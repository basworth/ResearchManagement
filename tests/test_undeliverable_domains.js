// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Steering people off addresses our mail doesn't reach.
//
// Rush University's filter quarantines a message from an outside Gmail account that carries a
// sign-in code. Gmail accepts it, so Supabase reports success and the app cheerfully says "Invite
// sent" for mail that will never arrive. Evidence from auth.users on 2026-09-03: rush.edu 1 of 7
// accounts ever signed in (and that one was never sent a code), against 8 of 9 for rushortho.com.
//
// This was written as a stopgap until sending moved to a domain of our own. That plan is dead:
// Rush blocks a newly registered domain outright, so studypipeline.com would arrive LESS reliably
// than the Gmail sender does. Adam's decision on 28 Sep 2026 was to stop chasing rush.edu and
// steer people to an address that works — so this is settled behaviour now, not a stopgap.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ADAM = "11111111-1111-1111-1111-111111111111";

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

function boot(opts) {
  opts = opts || {};
  const items = [
    { id: ADAM, kind: "profile", updated_at: now,
      data: { id: ADAM, name: "Adam Yanke", email: "adam.yanke@rushortho.com", position: "Clinician",
              admin: true, reportsTo: "", alertEmail: opts.alertEmail || "", linkedTo: "", alertEmailAsked: true, degreesAsked: true } },
    { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
      data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} } }
  ];
  const calls = [];
  const replies = opts.fnReplies || {};
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.fetch = async (url, o) => {
        let body = {}; try { body = JSON.parse(o.body); } catch (e) {}
        calls.push(body);
        const r = replies[body.action || "invite"] || { ok: true, message: "Invite sent." };
        return { ok: !r.error, status: r.error ? 400 : 200, json: async () => r };
      };
      win.supabase = { createClient: () => {
        const c = makeMockSupabase({ items: opts.items || items });
        c.auth.getSession = async () => ({ data: { session: { access_token: "tok", user: { id: opts.asId || ADAM, email: opts.asEmail || "adam.yanke@rushortho.com" } } }, error: null });
        return c;
      } };
    }
  });
  return { dom, calls };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function settings(dom, as) {
  const { window } = dom;
  await wait(600);
  as = as || { id: ADAM, email: "adam.yanke@rushortho.com" };
  window.eval(`currentUser = { id: ${JSON.stringify(as.id)}, email: ${JSON.stringify(as.email)} }; syncOnline = true;`);
  window.document.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
  await wait(60);
  window.eval(`tab = "settings"; render();`);
  await wait(400);
}
const NO_PENDING = { pending: { ok: true, pending: [], active: [] } };

(async () => {
  console.log("\n-- Spotting the domain --");
  {
    const { dom } = boot({ fnReplies: NO_PENDING }); const { window } = dom;
    await settings(dom);
    const bad = (e) => window.eval(`domainUndeliverable(${JSON.stringify(e)})`);
    check("rush.edu is flagged", bad("hannah_lundberg@rush.edu") === true);
    check("...whatever the case", bad("Hannah_Lundberg@Rush.EDU") === true);
    check("...and with stray spaces", bad("  steven_p_mell@rush.edu  ") === true);
    check("rushortho.com is not", bad("carla.edwards@rushortho.com") === false);
    check("A lookalike subdomain is not flagged", bad("x@mail.rush.edu") === false);
    check("A domain merely containing it is not", bad("x@notrush.edu") === false);
    check("Gmail is not", bad("someone@gmail.com") === false);
    check("Junk doesn't throw", bad("nonsense") === false && bad("") === false);

    const alt = (e) => window.eval(`suggestedAlternative(${JSON.stringify(e)})`);
    check("Underscores become dots for the suggestion",
      alt("hannah_lundberg@rush.edu") === "hannah.lundberg@rushortho.com", alt("hannah_lundberg@rush.edu"));
    check("A three-part name works too",
      alt("steven_p_mell@rush.edu") === "steven.p.mell@rushortho.com", alt("steven_p_mell@rush.edu"));
    check("No suggestion for an address that already works", alt("carla.edwards@rushortho.com") === "");
    window.close();
  }

  console.log("\n-- Inviting a rush.edu address stops and explains --");
  {
    const { dom, calls } = boot({ fnReplies: NO_PENDING });
    const { window } = dom, doc = window.document;
    await settings(dom);
    doc.getElementById("invite-email").value = "hannah_lundberg@rush.edu";
    doc.getElementById("invite-send").click();
    await wait(400);
    const sheet = doc.getElementById("sheet");
    check("It asks before sending", !!sheet);
    check("...naming the domain", sheet.textContent.indexOf("rush.edu") >= 0);
    check("...explaining it looks like phishing to them", /looks like\s+phishing/i.test(sheet.textContent.replace(/\s+/g, " ")));
    // Normalised: the copy wraps, so textContent holds "no\n        way to know".
    const flat = sheet.textContent.replace(/\s+/g, " ");
    check("...and that the app can't tell", /no way to know/i.test(flat), flat.slice(0, 200));
    check("...offering the address that works", doc.getElementById("f-invite-alt").value === "hannah.lundberg@rushortho.com",
      doc.getElementById("f-invite-alt").value);
    check("Nothing was sent yet", !calls.some(c => c.email), calls);

    doc.getElementById("sheet-save").click();
    await wait(500);
    check("Accepting sends to the working address",
      calls.some(c => c.email === "hannah.lundberg@rushortho.com"), calls);
    check("...and NOT to the rush.edu one", !calls.some(c => c.email === "hannah_lundberg@rush.edu"), calls);
    window.close();
  }

  console.log("\n-- Sending to it anyway is allowed, but honestly reported --");
  {
    const { dom, calls } = boot({ fnReplies: NO_PENDING });
    const { window } = dom, doc = window.document;
    await settings(dom);
    doc.getElementById("invite-email").value = "steven_p_mell@rush.edu";
    doc.getElementById("invite-send").click();
    await wait(400);
    doc.getElementById("f-invite-alt").value = "";   // clear the suggestion: send to the original
    doc.getElementById("sheet-save").click();
    await wait(500);
    check("It does send", calls.some(c => c.email === "steven_p_mell@rush.edu"), calls);
    check("...but warns it will probably be filtered",
      /expect it to be filtered/i.test(doc.getElementById("toast").textContent),
      doc.getElementById("toast").textContent);
    window.close();
  }

  console.log("\n-- Correcting the suggestion by hand --");
  {
    const { dom, calls } = boot({ fnReplies: NO_PENDING });
    const { window } = dom, doc = window.document;
    await settings(dom);
    doc.getElementById("invite-email").value = "cbelmont@rush.edu";
    doc.getElementById("invite-send").click();
    await wait(400);
    doc.getElementById("f-invite-alt").value = "catherine.belmont@rushortho.com";
    doc.getElementById("sheet-save").click();
    await wait(500);
    check("The typed address is used", calls.some(c => c.email === "catherine.belmont@rushortho.com"), calls);
    window.close();
  }

  console.log("\n-- A junk correction is refused --");
  {
    const { dom, calls } = boot({ fnReplies: NO_PENDING });
    const { window } = dom, doc = window.document;
    await settings(dom);
    doc.getElementById("invite-email").value = "someone@rush.edu";
    doc.getElementById("invite-send").click();
    await wait(400);
    doc.getElementById("f-invite-alt").value = "not-an-email";
    doc.getElementById("sheet-save").click();
    await wait(400);
    check("The sheet stays open", !!doc.getElementById("sheet"));
    check("Nothing sent", !calls.some(c => c.email), calls);
    window.close();
  }

  console.log("\n-- A working address is unaffected --");
  {
    const { dom, calls } = boot({ fnReplies: NO_PENDING });
    const { window } = dom, doc = window.document;
    await settings(dom);
    doc.getElementById("invite-email").value = "new.person@rushortho.com";
    doc.getElementById("invite-send").click();
    await wait(500);
    check("No warning sheet", !doc.getElementById("sheet"));
    check("Sent straight away", calls.some(c => c.email === "new.person@rushortho.com"), calls);
    window.close();
  }

  console.log("\n-- Stuck invites explain themselves in the waiting list --");
  {
    const { dom } = boot({ fnReplies: { pending: { ok: true, pending: [
      { id: "a", email: "hannah_lundberg@rush.edu", invitedAt: now, codeSentAt: now },
      { id: "b", email: "keeps.working@rushortho.com", invitedAt: now, codeSentAt: now }
    ], active: [] } } });
    const { window } = dom, doc = window.document;
    await settings(dom);
    await wait(300);
    const t = doc.getElementById("pending-invites").textContent;
    check("The rush.edu row says resending won't help", /resending won't help/i.test(t), t.slice(0, 300));
    check("...and points at the domain that works", t.indexOf("rushortho.com instead") >= 0);
    // The note must be attached to the right row, not the whole list.
    const rows = [...doc.querySelectorAll("#pending-invites .task-row")];
    // Identify by address, not by domain substring — the flagged row's OWN warning names
    // rushortho.com, which made an earlier version of this check find nothing.
    const bad = rows.find(r => r.textContent.indexOf("hannah_lundberg@rush.edu") >= 0);
    const good = rows.find(r => r.textContent.indexOf("keeps.working@rushortho.com") >= 0);
    check("Both rows are present", !!bad && !!good);
    check("The warning is on the rush.edu row", /won't help/i.test(bad.textContent));
    check("...and not on the working one", !/won't help/i.test(good.textContent), good.textContent);
    window.close();
  }

  console.log("\n-- Choosing one for alerts at sign-up is refused --");
  {
    const NEW = "99999999-9999-9999-9999-999999999999";
    const items = [{ id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
      data: { id: "00000000-0000-0000-0000-000000000001", names: [], degrees: {} } }];
    const { dom } = boot({ items, asId: NEW, asEmail: "newbie@rushortho.com", fnReplies: NO_PENDING });
    const { window } = dom, doc = window.document;
    await wait(600);
    window.eval(`currentUser = { id: ${JSON.stringify(NEW)}, email: "newbie@rushortho.com" }; syncOnline = true;`);
    doc.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
    await wait(60);
    window.eval("maybePromptDisplayName();");
    await wait(300);
    doc.getElementById("f-profile-name").value = "New Person";
    const sel = doc.getElementById("f-profile-position");
    sel.value = "Student"; sel.dispatchEvent(new window.Event("change", { bubbles: true }));
    await wait(60);
    doc.getElementById("f-alert-other").checked = true;
    doc.getElementById("f-alert-other").dispatchEvent(new window.Event("change", { bubbles: true }));
    await wait(60);
    doc.getElementById("f-alert-email").value = "new_person@rush.edu";
    doc.getElementById("sheet-save").click();
    await wait(400);
    check("The sheet stays open", !!doc.getElementById("sheet"));
    check("...saying alerts wouldn't reach them", /wouldn't reach you/i.test(doc.getElementById("toast").textContent),
      doc.getElementById("toast").textContent);
    check("Nothing was stored", window.eval(`(profileFor(${JSON.stringify(NEW)}) || {}).alertEmail || ""`) === "");
    // The sign-in address must still be accepted.
    doc.getElementById("f-alert-same").checked = true;
    doc.getElementById("f-alert-other").checked = false;
    doc.getElementById("sheet-save").click();
    await wait(400);
    check("Keeping the sign-in address works", !doc.getElementById("sheet"));
    window.close();
  }

  console.log("\n-- Choosing one from Settings is allowed but flagged --");
  {
    const { dom } = boot({ fnReplies: NO_PENDING });
    const { window } = dom, doc = window.document;
    await settings(dom);
    const box = doc.getElementById("me-alert");
    box.value = "a_yanke@rush.edu";
    box.dispatchEvent(new window.Event("change", { bubbles: true }));
    await wait(350);
    check("It saves — his address, his call",
      window.eval(`profileFor(${JSON.stringify(ADAM)}).alertEmail`) === "a_yanke@rush.edu",
      window.eval(`profileFor(${JSON.stringify(ADAM)}).alertEmail`));
    check("...but he's told alerts won't arrive",
      /won't arrive/i.test(doc.getElementById("toast").textContent), doc.getElementById("toast").textContent);
    window.close();
  }

  console.log("\n-- It's a decision, and the reasoning is written down --");
  {
    check("The list is still one constant, easy to change", /const UNDELIVERABLE_DOMAINS = \["rush\.edu"\]/.test(html));
    // It used to say TEMPORARY. It isn't: the replacement plan (our own sending domain) is what
    // failed, and someone reading this in six months needs to know that before they try it again.
    check("...no longer described as temporary", !/TEMPORARY[\s\S]{0,200}deleted once sending moves/.test(html));
    check("...recorded as a settled decision, with its date", /Settled policy as of 28 Sep 2026/.test(html));
    check("...explaining why a domain of our own would be worse, not better",
      /newly registered domain[\s\S]{0,300}LESS reliably|LESS reliably[\s\S]{0,300}Gmail sender/.test(html));
    check("...with the original evidence kept", /rush\.edu 1 of 7/.test(html));
  }

  console.log("\n-- Someone already on a rush.edu alert address is told --");
  {
    const { dom } = boot({ alertEmail: "adam_yanke@rush.edu", fnReplies: NO_PENDING });
    const { window } = dom;
    await settings(dom);
    const doc = window.document;
    // #main, not body: in jsdom body.textContent includes the inline script source, so searching
    // it would match this feature's own template whether or not it rendered.
    const t = doc.getElementById("main").textContent;
    check("Their own settings say the alerts aren't arriving", /alerts aren't reaching you/i.test(t), t.slice(0, 400));
    check("...naming the address", /adam_yanke@rush\.edu/.test(t));
    check("...and saying they were sent and discarded, not never sent",
      /silently discarded|quarantined/i.test(t));
    const fix = doc.getElementById("me-alert-fix");
    check("There's a one-tap fix", !!fix);
    check("...offering the rushortho equivalent", /adam\.yanke@rushortho\.com/.test(fix.textContent), fix.textContent);
    fix.click();
    await wait(300);
    check("Tapping it switches the address",
      window.eval(`(profileFor(${JSON.stringify(ADAM)}) || {}).alertEmail`) === "adam.yanke@rushortho.com",
      window.eval(`(profileFor(${JSON.stringify(ADAM)}) || {}).alertEmail`));
    check("The warning is gone once fixed", !/alerts aren't reaching you/i.test(window.document.getElementById("main").textContent));
    window.close();
  }
  {
    const { dom } = boot({ alertEmail: "adam.yanke@rushortho.com", fnReplies: NO_PENDING });
    const { window } = dom;
    await settings(dom);
    check("A working address gets no warning", !/alerts aren't reaching you/i.test(window.document.getElementById("main").textContent));
    window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
