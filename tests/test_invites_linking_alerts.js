// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Three things that only matter because people are messy:
//   1. An invite can sit unanswered for weeks, and the app can't see it — no profile row exists
//      until someone signs in. So the list has to come from the server.
//   2. One person gets invited at two addresses. Linking files the spare under a primary WITHOUT
//      deleting it: both addresses keep signing in, and either one shows the same work.
//   3. The address someone was invited at isn't always the one they read, so notifications are a
//      separate, personal choice.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();

const ADAM = "11111111-1111-1111-1111-111111111111";
const WILL_ORTHO = "22222222-2222-2222-2222-222222222222";
const WILL_RUSH = "33333333-3333-3333-3333-333333333333";
const CARLA = "44444444-4444-4444-4444-444444444444";

const profile = (id, name, email, extra) => ({ id, kind: "profile", updated_at: now,
  data: Object.assign({ id, name, email, position: "", reportsTo: "", alertEmail: "", linkedTo: "", alertEmailAsked: true }, extra || {}) });

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

// `fnReplies` maps an action name to what the edge function should answer. `as` is who's signed in.
function boot(opts) {
  opts = opts || {};
  const items = (opts.items || [
    profile(ADAM, "Adam Yanke", "adam.yanke@rushortho.com", { admin: true, position: "Clinician" }),
    profile(WILL_ORTHO, "William Lee", "william.lee@rushortho.com", { position: "Research assistant", reportsTo: ADAM }),
    profile(CARLA, "Carla Edwards", "carla.edwards@rushortho.com", { position: "Research manager (CRCM)", reportsTo: ADAM }),
    { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
      data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke", "William Lee", "Carla Edwards"], degrees: {} } }
  ]);
  const as = opts.as || { id: ADAM, email: "adam.yanke@rushortho.com" };
  const calls = [];
  const replies = opts.fnReplies || {};
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.fetch = async (url, o) => {
        const u = String(url);
        if (u.indexOf("/functions/v1/invite-user") >= 0) {
          const body = JSON.parse(o.body);
          calls.push(body);
          const r = replies[body.action || "invite"] || { ok: true, message: "Invite sent." };
          return { ok: !r.error, status: r.error ? 400 : 200, json: async () => r };
        }
        if (u.indexOf("/functions/v1/admin-requests") >= 0) {
          calls.push(JSON.parse(o.body));
          return { ok: true, status: 200, json: async () => ({ ok: true, message: "Done." }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      };
      win.supabase = { createClient: () => {
        const c = makeMockSupabase({ items });
        c.auth.getSession = async () => ({ data: { session: { access_token: "tok", user: { id: as.id, email: as.email } } }, error: null });
        return c;
      } };
    }
  });
  return { dom, calls, as };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const shown = (doc, id) => { const el = doc.getElementById(id); return !!el && el.style.display !== "none"; };

async function signedIn(dom, as) {
  const { window } = dom;
  await wait(600);
  window.eval(`currentUser = { id: ${JSON.stringify(as.id)}, email: ${JSON.stringify(as.email)} }; syncOnline = true;`);
  // Booting opens the app's own welcome sheet for the mock's default user; clear it so
  // "did a sheet appear?" isn't answered by the wrong sheet.
  window.document.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
  await wait(60);
}
async function openSettings(dom) {
  dom.window.eval(`tab = "settings"; render();`);
  await wait(300);
}

(async () => {
  // ================================================================= alert address
  console.log("\n-- Which address gets the alerts --");
  {
    const { dom } = boot();
    const { window } = dom;
    await signedIn(dom, { id: ADAM, email: "adam.yanke@rushortho.com" });
    const alertOf = (id) => window.eval(`alertEmailFor(${JSON.stringify(id)})`);
    check("Defaults to the sign-in address", alertOf(WILL_ORTHO) === "william.lee@rushortho.com", alertOf(WILL_ORTHO));
    window.eval(`profileFor(${JSON.stringify(WILL_ORTHO)}).alertEmail = "will.lee@rush.edu";`);
    check("A chosen address wins", alertOf(WILL_ORTHO) === "will.lee@rush.edu", alertOf(WILL_ORTHO));
    window.eval(`profileFor(${JSON.stringify(WILL_ORTHO)}).alertEmail = "";`);
    check("Clearing it falls back, rather than going blank", alertOf(WILL_ORTHO) === "william.lee@rushortho.com", alertOf(WILL_ORTHO));
    check("An unknown person yields nothing rather than throwing", alertOf("nobody") === "");
    window.close();
  }

  console.log("\n-- A new account is asked where to send them --");
  {
    const items = [{ id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
      data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} } }];
    const NEW = "55555555-5555-5555-5555-555555555555";
    const { dom } = boot({ items, as: { id: NEW, email: "cade.smelley@rushortho.com" } });
    const { window } = dom, doc = window.document;
    await signedIn(dom, { id: NEW, email: "cade.smelley@rushortho.com" });
    window.eval("maybePromptDisplayName();");
    await wait(300);
    check("The welcome sheet asks", !!doc.getElementById("sheet"));
    check("...naming the address they were invited at",
      doc.getElementById("sheet").textContent.indexOf("cade.smelley@rushortho.com") >= 0);
    check("...with 'use this one' pre-selected", doc.getElementById("f-alert-same").checked === true);
    check("...and the other box hidden until asked for", !shown(doc, "f-alert-box-row"));
    check("...and says sign-in doesn't change",
      /still sign in with/i.test(doc.getElementById("sheet").textContent));

    // Choosing "somewhere else" reveals the box.
    doc.getElementById("f-alert-other").checked = true;
    doc.getElementById("f-alert-other").dispatchEvent(new window.Event("change", { bubbles: true }));
    await wait(80);
    check("Picking 'somewhere else' reveals the box", shown(doc, "f-alert-box-row"));

    // A junk address must be refused, not silently stored.
    doc.getElementById("f-profile-name").value = "Cade Smelley";
    const sel = doc.getElementById("f-profile-position");
    sel.value = "Research assistant"; sel.dispatchEvent(new window.Event("change", { bubbles: true }));
    await wait(60);
    doc.getElementById("f-alert-email").value = "not-an-email";
    doc.getElementById("sheet-save").click();
    await wait(300);
    check("Junk address refused, sheet stays open", !!doc.getElementById("sheet"));

    doc.getElementById("f-alert-email").value = "cade@jagmail.southalabama.edu";
    doc.getElementById("sheet-save").click();
    await wait(400);
    const p = () => JSON.parse(window.eval(`JSON.stringify(profileFor(${JSON.stringify(NEW)}) || null)`));
    check("The chosen address is stored", p().alertEmail === "cade@jagmail.southalabama.edu", p());
    check("...and marked as answered", p().alertEmailAsked === true);
    check("Alerts resolve to it", window.eval(`alertEmailFor(${JSON.stringify(NEW)})`) === "cade@jagmail.southalabama.edu");
    // Asked once only.
    window.eval("maybePromptDisplayName();");
    await wait(280);
    check("Never asked again", !doc.getElementById("sheet"));
    window.close();
  }

  console.log("\n-- Keeping the invited address counts as an answer --");
  {
    const items = [{ id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
      data: { id: "00000000-0000-0000-0000-000000000001", names: [], degrees: {} } }];
    const NEW = "66666666-6666-6666-6666-666666666666";
    const { dom } = boot({ items, as: { id: NEW, email: "hannah@rushortho.com" } });
    const { window } = dom, doc = window.document;
    await signedIn(dom, { id: NEW, email: "hannah@rushortho.com" });
    window.eval("maybePromptDisplayName();");
    await wait(300);
    doc.getElementById("f-profile-name").value = "Hannah Reilly";
    const sel = doc.getElementById("f-profile-position");
    sel.value = "Student"; sel.dispatchEvent(new window.Event("change", { bubbles: true }));
    await wait(60);
    doc.getElementById("sheet-save").click();
    await wait(400);
    const p = JSON.parse(window.eval(`JSON.stringify(profileFor(${JSON.stringify(NEW)}))`));
    check("Nothing stored, so it keeps tracking the account", p.alertEmail === "", p);
    check("But it counts as answered", p.alertEmailAsked === true);
    check("Alerts go to the sign-in address", window.eval(`alertEmailFor(${JSON.stringify(NEW)})`) === "hannah@rushortho.com");
    window.close();
  }

  console.log("\n-- Typing your own address longhand doesn't freeze it --");
  {
    const items = [{ id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
      data: { id: "00000000-0000-0000-0000-000000000001", names: [], degrees: {} } }];
    const NEW = "77777777-7777-7777-7777-777777777777";
    const { dom } = boot({ items, as: { id: NEW, email: "thomas.vega@rushortho.com" } });
    const { window } = dom, doc = window.document;
    await signedIn(dom, { id: NEW, email: "thomas.vega@rushortho.com" });
    window.eval("maybePromptDisplayName();");
    await wait(300);
    doc.getElementById("f-profile-name").value = "Thomas Vega";
    const sel = doc.getElementById("f-profile-position");
    sel.value = "Student"; sel.dispatchEvent(new window.Event("change", { bubbles: true }));
    await wait(60);
    doc.getElementById("f-alert-other").checked = true;
    doc.getElementById("f-alert-other").dispatchEvent(new window.Event("change", { bubbles: true }));
    await wait(60);
    doc.getElementById("f-alert-email").value = "Thomas.Vega@rushortho.com"; // same, different case
    doc.getElementById("sheet-save").click();
    await wait(400);
    check("Stored blank, because it's the same address",
      JSON.parse(window.eval(`JSON.stringify(profileFor(${JSON.stringify(NEW)}))`)).alertEmail === "");
    window.close();
  }

  console.log("\n-- Changing it later from Settings --");
  {
    const { dom } = boot();
    const { window } = dom, doc = window.document;
    await signedIn(dom, { id: ADAM, email: "adam.yanke@rushortho.com" });
    await openSettings(dom);
    const box = doc.getElementById("me-alert");
    check("There's a box for it in Settings", !!box);
    check("...empty, because he uses his sign-in address", box.value === "");
    check("...showing where alerts go now",
      doc.getElementById("main").textContent.indexOf("adam.yanke@rushortho.com") >= 0);
    // A deliverable domain on purpose: the quarantine warning has its own test file,
    // and using rush.edu here would assert the wrong message.
    box.value = "ayanke@northwestern.edu";
    box.dispatchEvent(new window.Event("change", { bubbles: true }));
    await wait(300);
    check("Saved", window.eval(`profileFor(${JSON.stringify(ADAM)}).alertEmail`) === "ayanke@northwestern.edu");
    check("...and confirmed out loud", /ayanke@northwestern\.edu/.test(doc.getElementById("toast").textContent),
      doc.getElementById("toast").textContent);
    // Junk must not overwrite a good value.
    const box2 = doc.getElementById("me-alert");
    box2.value = "nonsense";
    box2.dispatchEvent(new window.Event("change", { bubbles: true }));
    await wait(250);
    check("Junk is refused and the good address survives",
      window.eval(`profileFor(${JSON.stringify(ADAM)}).alertEmail`) === "ayanke@northwestern.edu",
      window.eval(`profileFor(${JSON.stringify(ADAM)}).alertEmail`));
    window.close();
  }

  // ================================================================= linking
  console.log("\n-- One person, two accounts --");
  {
    const items = [
      profile(ADAM, "Adam Yanke", "adam.yanke@rushortho.com", { admin: true, position: "Clinician" }),
      profile(WILL_ORTHO, "William Lee", "william.lee@rushortho.com", { position: "Research assistant", reportsTo: ADAM }),
      profile(WILL_RUSH, "William Lee", "william_k_lee@rush.edu", { position: "Research assistant", reportsTo: ADAM }),
      { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
        data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke", "William Lee"], degrees: {} } }
    ];
    const { dom } = boot({ items });
    const { window } = dom, doc = window.document;
    await signedIn(dom, { id: ADAM, email: "adam.yanke@rushortho.com" });

    check("Both Williams show up before linking",
      window.eval("activeProfiles().length") === 3, window.eval("activeProfiles().length"));

    // Link the rush.edu row under the rushortho.com one.
    window.eval(`openOrgSheet(${JSON.stringify(WILL_RUSH)})`);
    await wait(250);
    const link = doc.getElementById("f-org-link");
    check("The sheet offers a 'same person as' picker", !!link);
    check("...listing the other William", [...link.options].some(o => o.textContent.indexOf("William Lee") >= 0));
    check("...and does NOT offer himself", ![...link.options].some(o => o.value === WILL_RUSH));
    check("...explaining nothing gets deleted",
      /Nothing is deleted/i.test(doc.getElementById("sheet").textContent));
    link.value = WILL_ORTHO;
    doc.getElementById("sheet-save").click();
    await wait(400);

    check("Now counted as one person", window.eval("activeProfiles().length") === 2, window.eval("activeProfiles().length"));
    check("The spare is recognised as linked", window.eval(`isLinkedProfile(profileFor(${JSON.stringify(WILL_RUSH)}))`) === true);
    check("The primary is not", window.eval(`isLinkedProfile(profileFor(${JSON.stringify(WILL_ORTHO)}))`) === false);
    check("The spare's row is gone from the chart",
      window.eval("orgChartHTML(false)").indexOf("william_k_lee@rush.edu") < 0);
    check("...but the primary is still there",
      window.eval("orgChartHTML(false)").indexOf("william.lee@rushortho.com") >= 0);
    check("Nothing was removed from the data",
      window.eval("state.profiles.length") === 3, window.eval("state.profiles.length"));
    check("The spare still knows its own address",
      window.eval(`profileFor(${JSON.stringify(WILL_RUSH)}).email`) === "william_k_lee@rush.edu");
    check("It was announced with an undo route",
      /Linked Accounts/i.test(doc.getElementById("toast").textContent), doc.getElementById("toast").textContent);

    // Signing in as the spare must behave like the primary.
    window.eval(`currentUser = { id: ${JSON.stringify(WILL_RUSH)}, email: "william_k_lee@rush.edu" };`);
    check("Signing in with the second address gives the same name", window.eval("me()") === "William Lee", window.eval("me()"));
    window.eval(`profileFor(${JSON.stringify(WILL_ORTHO)}).alertEmail = "will@rush.edu";`);
    check("...and one stream of alerts, at the primary's address",
      window.eval(`alertEmailFor(${JSON.stringify(WILL_RUSH)})`) === "will@rush.edu",
      window.eval(`alertEmailFor(${JSON.stringify(WILL_RUSH)})`));
    window.close();
  }

  console.log("\n-- A link can always be undone --");
  {
    const items = [
      profile(ADAM, "Adam Yanke", "adam.yanke@rushortho.com", { admin: true }),
      profile(WILL_ORTHO, "William Lee", "william.lee@rushortho.com", { reportsTo: ADAM }),
      profile(WILL_RUSH, "William Lee", "william_k_lee@rush.edu", { reportsTo: ADAM, linkedTo: WILL_ORTHO }),
      { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
        data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke", "William Lee"], degrees: {} } }
    ];
    const { dom } = boot({ items });
    const { window } = dom, doc = window.document;
    await signedIn(dom, { id: ADAM, email: "adam.yanke@rushortho.com" });
    await openSettings(dom);
    check("Settings lists the linked pair", doc.getElementById("main").textContent.indexOf("also signs in as") >= 0);
    check("...naming the spare address", doc.getElementById("main").textContent.indexOf("william_k_lee@rush.edu") >= 0);
    const btn = doc.querySelector("[data-unlink]");
    check("...with an Unlink button", !!btn);
    btn.click();
    await wait(350);
    check("Unlinked", window.eval(`isLinkedProfile(profileFor(${JSON.stringify(WILL_RUSH)}))`) === false);
    check("Back to two people", window.eval("activeProfiles().length") === 3);
    check("...and said so plainly", /own person again/i.test(doc.getElementById("toast").textContent),
      doc.getElementById("toast").textContent);
    window.close();
  }

  console.log("\n-- A link that would point in a circle is refused --");
  {
    const items = [
      profile(ADAM, "Adam Yanke", "adam.yanke@rushortho.com", { admin: true }),
      profile(WILL_ORTHO, "William Lee", "william.lee@rushortho.com", { linkedTo: WILL_RUSH }),
      profile(WILL_RUSH, "William Lee", "william_k_lee@rush.edu", {}),
      { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
        data: { id: "00000000-0000-0000-0000-000000000001", names: [], degrees: {} } }
    ];
    const { dom } = boot({ items });
    const { window } = dom, doc = window.document;
    await signedIn(dom, { id: ADAM, email: "adam.yanke@rushortho.com" });
    window.eval(`openOrgSheet(${JSON.stringify(WILL_RUSH)})`);
    await wait(250);
    const link = doc.getElementById("f-org-link");
    // WILL_ORTHO already points at WILL_RUSH, so it must not be offered back.
    check("The row pointing at this one isn't offered", ![...link.options].some(o => o.value === WILL_ORTHO));
    // Force it anyway, the way a stale DOM or a future call site might.
    const opt = doc.createElement("option"); opt.value = WILL_ORTHO; link.appendChild(opt);
    link.value = WILL_ORTHO;
    doc.getElementById("sheet-save").click();
    await wait(300);
    check("Saving it is refused, sheet stays open", !!doc.getElementById("sheet"));
    check("...with an explanation", /already linked the other way/i.test(doc.getElementById("toast").textContent),
      doc.getElementById("toast").textContent);
    check("...and no loop was written", window.eval(`profileFor(${JSON.stringify(WILL_RUSH)}).linkedTo`) !== WILL_ORTHO);
    window.close();
  }

  // ================================================================= pending invites
  console.log("\n-- Invites still waiting --");
  {
    const old = new Date(Date.now() - 21 * 86400e3).toISOString();
    const { dom, calls } = boot({ fnReplies: { pending: { ok: true,
      pending: [
        { id: "a", email: "matthew.kao@rushortho.com", invitedAt: old, codeSentAt: old },
        { id: "b", email: "ccs1724@jagmail.southalabama.edu", invitedAt: new Date().toISOString(), codeSentAt: new Date().toISOString() }
      ], active: [] } } });
    const { window } = dom, doc = window.document;
    await signedIn(dom, { id: ADAM, email: "adam.yanke@rushortho.com" });
    await openSettings(dom);
    await wait(400);
    const box = doc.getElementById("pending-invites");
    check("The section exists", !!box);
    check("It asked the server", calls.some(c => c.action === "pending"), calls);
    check("Both outstanding invites are listed", box.textContent.indexOf("matthew.kao@rushortho.com") >= 0 && box.textContent.indexOf("ccs1724@jagmail") >= 0);
    check("The three-week-old one is aged", /21 days ago/.test(box.textContent), box.textContent.slice(0, 200));
    check("...and its code called out as expired", /code has expired/.test(box.textContent));
    check("Today's one says the code is still good", /code still valid/.test(box.textContent));
    check("Oldest first, so the stalest is top",
      box.textContent.indexOf("matthew.kao") < box.textContent.indexOf("ccs1724"));

    const btn = box.querySelector("[data-resend]");
    check("Each has a Resend button", !!btn);
    btn.click();
    await wait(400);
    check("Resend names the address", calls.some(c => c.action === "resend" && c.email === "matthew.kao@rushortho.com"), calls);
    // Delete arrived later, at Adam's explicit request (2026-09-02). It's the one destructive
    // action in the app and it's narrow: see test_invite_cleanup.js for the guards.
    check("There's a Delete button too", !!box.querySelector("[data-invite-del]"));
    check("...and it asks before doing anything", !doc.getElementById("sheet"));
    window.close();
  }

  console.log("\n-- Nothing outstanding says so, rather than looking broken --");
  {
    const { dom } = boot({ fnReplies: { pending: { ok: true, pending: [], active: [] } } });
    const { window } = dom, doc = window.document;
    await signedIn(dom, { id: ADAM, email: "adam.yanke@rushortho.com" });
    await openSettings(dom);
    await wait(400);
    check("Says everyone's in", /everyone invited has signed in/i.test(doc.getElementById("pending-invites").textContent),
      doc.getElementById("pending-invites").textContent);
    window.close();
  }

  console.log("\n-- An out-of-date server is explained, not leaked --");
  {
    const { dom } = boot({ fnReplies: { pending: { error: "Unknown action" } } });
    const { window } = dom, doc = window.document;
    await signedIn(dom, { id: ADAM, email: "adam.yanke@rushortho.com" });
    await openSettings(dom);
    await wait(400);
    const t = doc.getElementById("pending-invites").textContent;
    check("Explains it plainly", /hasn't picked up this feature yet/i.test(t), t);
    check("...without the raw error", !/Unknown action/.test(t), t);
    window.close();
  }

  // ================================================================= duplicate warning
  console.log("\n-- Inviting someone who's probably already here --");
  {
    const { dom, calls } = boot({ fnReplies: {
      invite: { ok: false, needsConfirm: true, message: "looks like someone already invited",
        similar: [{ email: "william.lee@rushortho.com", name: "William Lee", signedIn: true }] },
      pending: { ok: true, pending: [], active: [] }
    } });
    const { window } = dom, doc = window.document;
    await signedIn(dom, { id: ADAM, email: "adam.yanke@rushortho.com" });
    await openSettings(dom);
    await wait(400);
    // Deliverable domain, so this exercises the duplicate question rather than the
    // undeliverable-domain one, which opens its own sheet first.
    doc.getElementById("invite-email").value = "wlee@rushortho.com";
    doc.getElementById("invite-send").click();
    await wait(500);
    const sheet = doc.getElementById("sheet");
    check("It stops and asks", !!sheet);
    check("...naming who it might be", sheet.textContent.indexOf("William Lee") >= 0);
    check("...and that address", sheet.textContent.indexOf("william.lee@rushortho.com") >= 0);
    check("...saying they've signed in", /has signed in/.test(sheet.textContent));
    check("...pointing at the linking tool", /Same person as/.test(sheet.textContent));
    check("The button reads as sending, not saving", doc.getElementById("sheet-save").textContent === "Send it anyway",
      doc.getElementById("sheet-save").textContent);
    check("Nothing was sent yet", !calls.some(c => c.confirm === true), calls);

    doc.getElementById("sheet-save").click();
    await wait(500);
    check("Confirming sends it, with the override",
      calls.some(c => c.confirm === true && c.email === "wlee@rushortho.com"), calls);
    window.close();
  }

  console.log("\n-- Backing out of that question sends nothing --");
  {
    const { dom, calls } = boot({ fnReplies: {
      invite: { ok: false, needsConfirm: true, similar: [{ email: "a@b.com", name: "Someone", signedIn: false }] },
      pending: { ok: true, pending: [], active: [] }
    } });
    const { window } = dom, doc = window.document;
    await signedIn(dom, { id: ADAM, email: "adam.yanke@rushortho.com" });
    await openSettings(dom);
    await wait(400);
    doc.getElementById("invite-email").value = "a.b@rushortho.com";
    doc.getElementById("invite-send").click();
    await wait(500);
    doc.getElementById("sheet-cancel").click();
    await wait(350);
    check("No confirmed invite went out", !calls.some(c => c.confirm === true), calls);
    check("The address is still in the box to fix",
      doc.getElementById("invite-email").value === "a.b@rushortho.com");
    window.close();
  }

  console.log("\n-- Non-admins see none of this --");
  {
    const { dom } = boot({ as: { id: CARLA, email: "carla.edwards@rushortho.com" } });
    const { window } = dom, doc = window.document;
    await signedIn(dom, { id: CARLA, email: "carla.edwards@rushortho.com" });
    await openSettings(dom);
    await wait(400);
    check("No invite box", !doc.getElementById("invite-email"));
    check("No pending-invites list", !doc.getElementById("pending-invites"));
    check("But she can still set her own alerts address", !!doc.getElementById("me-alert"));
    window.close();
  }

  // ================================================================= the server side
  console.log("\n-- The server is what actually decides --");
  {
    const fn = fs.readFileSync(PROJECT + "/supabase/functions/invite-user/index.ts", "utf8");
    check("A pending action exists", fn.indexOf('action === "pending"') > 0);
    check("A resend action exists", fn.indexOf('action === "resend"') > 0);
    check("Admin is checked before any of it",
      fn.indexOf("Only admins can invite people") < fn.indexOf('action === "pending"'));
    check("listUsers is paged, not just the first 50",
      /listUsers\(\{\s*page,\s*perPage:\s*\d+\s*\}\)/.test(fn) && /for \(let page = 1/.test(fn));
    // deleteUser exists now, but only inside the cancel action and only for an account that has
    // never signed in — the guard, not its absence, is what makes this safe.
    check("The only deletion is the cancel action", (fn.match(/deleteUser/g) || []).length === 1);
    check("...gated on never having signed in", /last_sign_in_at[\s\S]{0,200}409/.test(fn));
    check("The duplicate check is skippable by confirming", /body\?\.confirm !== true/.test(fn));
    check("...and never hard-refuses", fn.indexOf("needsConfirm") > 0);
    check("No stale digit count in the copy", !/\d[- ]?digit/i.test(fn));

    const te = fs.readFileSync(PROJECT + "/supabase/functions/task-emails/index.ts", "utf8");
    const sa = fs.readFileSync(PROJECT + "/supabase/functions/stage-alerts/index.ts", "utf8");
    check("Task emails honour the chosen address", /alertEmail/.test(te));
    check("...and skip linked spares", /p\.linkedTo/.test(te));
    check("Stage alerts honour it too", /alertEmail/.test(sa));
    check("...and skip linked spares", /p\.linkedTo/.test(sa));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
