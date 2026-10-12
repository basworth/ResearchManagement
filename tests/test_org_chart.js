// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Org chart: per-person position + reporting line + admin tick, a first-login role prompt,
// and an off-by-default switch that decides whether any of it affects permissions.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ADAM = "11111111-1111-1111-1111-111111111111";
const CARLA = "22222222-2222-2222-2222-222222222222";
const CADE = "33333333-3333-3333-3333-333333333333";

const mockItems = [
  { id: "s-adam", kind: "study", data: { id: "s-adam", title: "Adam's Study", pi: "Adam Yanke", team: [], design: "Prospective (Consented)", phase: "Concept", priority: "Medium", irb: "1", milestones: [] }, updated_at: now },
  { id: "s-cade", kind: "study", data: { id: "s-cade", title: "Cade's Study", pi: "Cade Smelley", team: ["Cade Smelley"], design: "Prospective (Consented)", phase: "Concept", priority: "Medium", irb: "2", milestones: [] }, updated_at: now },
  { id: "s-other", kind: "study", data: { id: "s-other", title: "Unrelated Study", pi: "Someone Else", team: ["Someone Else"], design: "Prospective (Consented)", phase: "Concept", priority: "Medium", irb: "3", milestones: [] }, updated_at: now },
  { id: ADAM, kind: "profile", data: { id: ADAM, email: "adam.yanke@rushortho.com", name: "Adam Yanke", position: "Clinician", reportsTo: "", admin: true }, updated_at: now },
  { id: CARLA, kind: "profile", data: { id: CARLA, email: "carla.edwards@rushortho.com", name: "Carla Edwards", position: "Research manager (CRCM)", reportsTo: ADAM, admin: false }, updated_at: now },
  { id: CADE, kind: "profile", data: { id: CADE, email: "ccs1724@jagmail.southalabama.edu", name: "Cade Smelley", position: "", reportsTo: CARLA, admin: false }, updated_at: now },
  { id: "00000000-0000-0000-0000-000000000001", kind: "meta", data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke", "Carla Edwards", "Cade Smelley"], degrees: {} }, updated_at: now }
];

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
function build(asUserId) {
  return new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => {
        const c = makeMockSupabase({ items: mockItems.map(r => JSON.parse(JSON.stringify(r))) });
        const u = mockItems.find(r => r.id === asUserId);
        c.auth.getSession = async () => ({ data: { session: { user: { id: asUserId, email: u ? u.data.email : "new@rushortho.com" } } }, error: null });
        return c;
      } };
    }
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log("\n-- Positions offered --");
  const d = build(ADAM); const w = d.window, doc = w.document;
  await wait(400);
  w.eval("syncOnline = true");
  const pos = JSON.parse(w.eval("JSON.stringify(POSITIONS)"));
  check("Clinician replaces the old Faculty label", pos.includes("Clinician") && !pos.includes("Faculty"), pos);
  check("Scientist is offered", pos.includes("Scientist"));
  check("Sports medicine fellow is offered", pos.includes("Sports medicine fellow"));
  check("Orthopedic resident is offered", pos.includes("Orthopedic resident"));
  check("Research manager (CRCM) is offered", pos.includes("Research manager (CRCM)"));
  check("Research assistant is offered", pos.includes("Research assistant"));

  console.log("\n-- The chart renders the reporting line --");
  doc.querySelector('button[data-tab="settings"]').click();
  await wait(120);
  const s = doc.getElementById("main").innerHTML;
  check("Adam appears", s.includes("Adam Yanke"));
  check("Carla appears under him", s.includes("Carla Edwards"));
  check("Cade appears", s.includes("Cade Smelley"));
  check("Positions are shown", s.includes("Research manager (CRCM)") && s.includes("Clinician"));
  check("Someone with no role set is flagged", s.includes("role not set"));
  check("Admin badge shows on Adam", s.includes(">admin<"));
  check("Depth is expressed as indentation", /padding-left:18px/.test(s) && /padding-left:36px/.test(s), null);
  check("Admins get Edit buttons", s.includes("data-org-edit"));

  console.log("\n-- The permission switch is off by default --");
  check("orgPermissions starts false", w.eval("state.orgPermissions") === false);
  check("The toggle is rendered for an admin", !!doc.getElementById("org-perms-toggle"));
  check("...and is unchecked", doc.getElementById("org-perms-toggle").checked === false);
  check("Admin still comes from the hardcoded list", w.eval("isAdmin()") === true);
  check("Nobody is 'managed' while the switch is off", w.eval("JSON.stringify(namesIManage())") === "[]");

  console.log("\n-- With the switch off, Carla sees only her own work --");
  const d2 = build(CARLA); const w2 = d2.window, doc2 = d2.window.document;
  await wait(400);
  w2.eval("syncOnline = true");
  check("Carla is not an admin", w2.eval("isAdmin()") === false);
  check("...and can't see Cade's study", w2.eval('visibleStudies().some(s => s.id === "s-cade")') === false);
  check("...and gets no Edit buttons", !doc2.querySelector("[data-org-edit]"));

  console.log("\n-- A non-admin cannot edit the chart by any route --");
  check("The Edit buttons aren't rendered for her", !doc2.querySelector("[data-org-edit]"));
  check("The permissions toggle isn't rendered either", !doc2.getElementById("org-perms-toggle"));
  w2.eval(`openOrgSheet("${CADE}")`);
  await wait(100);
  check("Calling the edit sheet directly is refused", !doc2.getElementById("f-org-pos"));
  const posBefore = w2.eval(`(profileFor("${CADE}").position || "")`);
  w2.eval(`updateProfileFields("${CADE}", { position: "Clinician", admin: true })`);
  await wait(80);
  check("Calling the save function directly changes nothing",
    w2.eval(`profileFor("${CADE}").position`) === posBefore, w2.eval(`profileFor("${CADE}").position`));
  check("...and can't self-promote to admin", w2.eval(`!!profileFor("${CADE}").admin`) === false);
  check("She can still set her OWN name and role", (function(){
    w2.eval('upsertProfile("Carla Edwards", { position: "Coordinator" })');
    return w2.eval('positionOf(currentUser.id)') === "Coordinator";
  })());
  w2.eval('upsertProfile("Carla Edwards", { position: "Research manager (CRCM)" })');

  console.log("\n-- Switching it on makes Carla a manager of her reports --");
  w2.eval("state.orgPermissions = true; render();");
  await wait(80);
  check("Cade counts as someone she manages", w2.eval('JSON.stringify(namesIManage())') === '["Cade Smelley"]', w2.eval('JSON.stringify(namesIManage())'));
  check("She can now see Cade's study", w2.eval('visibleStudies().some(s => s.id === "s-cade")') === true);
  check("...but still not unrelated work", w2.eval('visibleStudies().some(s => s.id === "s-other")') === false);
  check("...and is still not an admin", w2.eval("isAdmin()") === false);
  check("canSeeStudy agrees", w2.eval('canSeeStudy(state.studies.find(s => s.id === "s-cade"))') === true);

  console.log("\n-- Admin now follows the tick, not the hardcoded list --");
  // Set the flag directly rather than via updateProfileFields — that function now (correctly)
  // refuses non-admins, so this stands in for an admin having granted her the tick.
  w2.eval(`(function(){ profileFor("${CARLA}").admin = true; })(); render();`);
  await wait(80);
  check("Ticking admin promotes her", w2.eval("isAdmin()") === true);
  check("...so she sees everything", w2.eval("visibleStudies().length") === 3);
  // The org-permissions switch governs who can see whose work, not who is an admin — isAdmin()
  // reads the profile's own tick. Turning the switch off must NOT quietly revoke admin rights.
  w2.eval("state.orgPermissions = false; render();");
  await wait(80);
  check("Turning the visibility switch off leaves her admin tick alone", w2.eval("isAdmin()") === true, w2.eval("isAdmin()"));
  w2.eval(`(function(){ profileFor("${CARLA}").admin = false; })(); render();`);
  await wait(80);
  check("Clearing the tick is what demotes her", w2.eval("isAdmin()") === false, w2.eval("isAdmin()"));

  console.log("\n-- Reporting loops can't be created or crash the chart --");
  const d3 = build(ADAM); const w3 = d3.window, doc3 = d3.window.document;
  await wait(400);
  w3.eval("syncOnline = true");
  w3.eval(`openOrgSheet("${ADAM}")`);
  await wait(100);
  check("The edit sheet no longer offers an admin checkbox", !doc3.getElementById("f-org-admin"));
  const bossOpts = [...doc3.getElementById("f-org-boss").options].map(o => o.value);
  check("Adam can't be made to report to his own report", !bossOpts.includes(CARLA), bossOpts);
  check("...nor to someone further down", !bossOpts.includes(CADE));
  check("...and 'top of chart' is available", bossOpts.includes(""));
  doc3.getElementById("sheet-cancel").click();
  await wait(60);
  // Force a loop directly in state and confirm rendering survives it.
  w3.eval(`(function(){ var a = profileFor("${ADAM}"); a.reportsTo = "${CADE}"; })(); tab = "settings"; render();`);
  await wait(120);
  check("A forced loop doesn't hang or blank the page", doc3.getElementById("main").innerHTML.length > 500);
  check("...and the trapped people are surfaced", doc3.getElementById("main").innerHTML.includes("report in a circle"));
  check("...without pretending nobody has signed in",
    !doc3.getElementById("main").innerHTML.includes("Nobody has signed in yet"));
  check("...and they're still editable", doc3.getElementById("main").innerHTML.includes("data-org-edit"));

  console.log("\n-- First login asks for a role --");
  const d4 = build("44444444-4444-4444-4444-444444444444");
  await wait(500);
  const doc4 = d4.window.document;
  check("A brand-new account is prompted", !!doc4.getElementById("f-profile-position"), doc4.body.innerHTML.slice(0, 200));
  check("...for their name too", !!doc4.getElementById("f-profile-name"));
  const sel = doc4.getElementById("f-profile-position");
  check("...with the real position list", [...sel.options].some(o => o.value === "Sports medicine fellow"));
  check("...defaulting to nothing chosen", sel.value === "— select —", sel.value);
  doc4.getElementById("f-profile-name").value = "New Person";
  doc4.getElementById("sheet-save").click();
  await wait(80);
  check("Saving without a role is refused", !!doc4.getElementById("f-profile-position"));
  doc4.getElementById("f-profile-position").value = "Sports medicine fellow";
  doc4.getElementById("sheet-save").click();
  // closeSheet() removes the node on a 320ms timer, so give it room before asserting.
  await wait(450);
  check("Choosing one lets it save", !doc4.getElementById("f-profile-position"));
  check("...and it's recorded", d4.window.eval('positionOf(currentUser.id)') === "Sports medicine fellow");

  console.log("\n-- Someone who already has a name but no role is asked once --");
  const d5 = build(CADE);
  await wait(500);
  const doc5 = d5.window.document;
  check("Cade is asked for a role", !!doc5.getElementById("f-profile-position"));
  check("...but not re-asked for his name", !doc5.getElementById("f-profile-name"));

  console.log("\n-- Somebody already complete is left alone, once degrees are settled --");
  // Adam is a Clinician, which is an author-list role, so he IS asked for degrees once. That's
  // the point of the sign-up degrees question: it also backfills existing accounts.
  const d6 = build(ADAM);
  await wait(500);
  const doc6 = d6.window.document;
  check("A complete profile with an author-list role is asked for degrees once",
    !!doc6.getElementById("f-profile-degrees"));
  check("...and not re-asked for a name", !doc6.getElementById("f-profile-name"));
  // Marking degrees answered leaves ONE question outstanding: where alerts should go. Existing
  // accounts predate that setting, so they're asked once too — which is the point of it.
  d6.window.eval(`(function(){ var p = profileFor(currentUser.id); p.degreesAsked = true; })();`);
  doc6.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
  d6.window.eval("maybePromptDisplayName();");
  await wait(300);
  check("Degrees answered, so now it asks about the alerts address", !!doc6.getElementById("f-alert-same"));
  check("...and not for a name again", !doc6.getElementById("f-profile-name"));
  d6.window.eval(`(function(){ var p = profileFor(currentUser.id); p.alertEmailAsked = true; })();`);
  doc6.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
  d6.window.eval("maybePromptDisplayName();");
  await wait(300);
  check("Once everything is answered, nothing is asked again", !doc6.getElementById("f-profile-position"));

  console.log("\n-- A role that never appears on author lists is never asked --");
  const d7 = build(CARLA);
  await wait(500);
  // The block is in the sheet's markup either way; for a CRCM it stays collapsed. So this asks
  // whether it's SHOWN, not whether it exists.
  const degBlock = d7.window.document.getElementById("f-profile-degrees");
  check("Carla, a CRCM, is never shown the degrees question",
    !degBlock || degBlock.style.display === "none",
    degBlock && degBlock.style.display);
  // She IS asked where alerts should go — that question applies to everyone, regardless of role.
  check("...though she is asked about the alerts address, like everyone",
    !!d7.window.document.getElementById("f-alert-same"));
  d7.window.eval(`(function(){ var p = profileFor(currentUser.id); p.alertEmailAsked = true; })();`);
  d7.window.document.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
  d7.window.eval("maybePromptDisplayName();");
  await wait(300);
  check("...and after that, nothing at all", !d7.window.document.getElementById("f-profile-position"));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
