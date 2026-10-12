// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Degrees exist to produce manuscript-ready author lists, and sign-up is the one moment the
// person themselves is present and knows the answer. Asked only for the roles that end up on
// author lists — clinician, scientist, fellow, resident, research assistant — and asked once,
// so someone who holds none isn't nagged forever.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ME = "11111111-1111-1111-1111-111111111111";

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

// `profileData` seeds an existing profile row (omit for a brand-new account).
// `degrees` seeds the roster's degree map.
function boot(profileData, degrees) {
  const items = [{ id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
    data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke", "Nathan Varady"], degrees: degrees || {} } }];
  if (profileData) items.push({ id: ME, kind: "profile", updated_at: now, data: Object.assign({ id: ME, email: "me@rushortho.com" }, profileData) });
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items }) };
    }
  });
  return dom;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const setSel = (doc, id, v) => { const el = doc.getElementById(id); el.value = v; el.dispatchEvent(new el.ownerDocument.defaultView.Event("change", { bubbles: true })); };
const shown = (doc, id) => { const el = doc.getElementById(id); return !!el && el.style.display !== "none"; };

async function prompt(dom) {
  const { window } = dom, doc = window.document;
  // Booting signs in as the mock's own default user, which has no profile — so the app opens its
  // own welcome sheet. Clear that first, otherwise "did a sheet appear?" is answered by the
  // wrong sheet.
  window.eval(`currentUser = { id: ${JSON.stringify(ME)}, email: "me@rushortho.com" }; syncOnline = true;`);
  doc.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
  await wait(60);
  window.eval("maybePromptDisplayName();");
  await wait(280);
  return doc.getElementById("sheet");
}

(async () => {
  console.log("\n-- Which roles get asked --");
  {
    const dom = boot(); const { window } = dom;
    await wait(600);
    const wants = (r) => window.eval(`positionWantsDegrees(${JSON.stringify(r)})`);
    check("Clinician: yes", wants("Clinician") === true);
    check("Scientist: yes", wants("Scientist") === true);
    check("Sports medicine fellow: yes", wants("Sports medicine fellow") === true);
    check("Orthopedic resident: yes", wants("Orthopedic resident") === true);
    check("Research assistant: yes", wants("Research assistant") === true);
    check("Research manager (CRCM): no", wants("Research manager (CRCM)") === false);
    check("Student: no", wants("Student") === false);
    check("Every asked role is a real position",
      JSON.parse(window.eval("JSON.stringify(DEGREE_POSITIONS)"))
        .every(r => JSON.parse(window.eval("JSON.stringify(POSITIONS)")).indexOf(r) >= 0));
    window.close();
  }

  console.log("\n-- A new account: degrees appear once an author-list role is picked --");
  {
    const dom = boot(); const { window } = dom, doc = window.document;
    await wait(600);
    await prompt(dom);
    check("The welcome sheet opens", !!doc.getElementById("sheet"));
    check("Name and role are asked", !!doc.getElementById("f-profile-name") && !!doc.getElementById("f-profile-position"));
    check("Degrees start hidden, before a role is chosen", !shown(doc, "f-profile-degrees"));

    setSel(doc, "f-profile-position", "Research manager (CRCM)");
    await wait(80);
    check("Still hidden for a CRCM", !shown(doc, "f-profile-degrees"));

    setSel(doc, "f-profile-position", "Orthopedic resident");
    await wait(80);
    check("Shown for a resident", shown(doc, "f-profile-degrees"));
    check("...offering the standard degrees", doc.querySelectorAll(".f-profile-degree").length > 10,
      doc.querySelectorAll(".f-profile-degree").length);
    check("...with an Other box for anything missing", !!doc.getElementById("f-profile-degree-other"));
    check("...and says it's optional and asked once",
      /Skip it if none apply[\s\S]*won't be asked again/i.test(doc.getElementById("f-profile-degrees").textContent),
      doc.getElementById("f-profile-degrees").textContent.slice(0, 140));

    setSel(doc, "f-profile-position", "Student");
    await wait(80);
    check("Hidden again for a student", !shown(doc, "f-profile-degrees"));
    window.close();
  }

  console.log("\n-- Saving records the degrees against the name --");
  {
    const dom = boot(); const { window } = dom, doc = window.document;
    await wait(600);
    await prompt(dom);
    doc.getElementById("f-profile-name").value = "Nathan Varady";
    setSel(doc, "f-profile-position", "Sports medicine fellow");
    await wait(80);
    doc.querySelector('.f-profile-degree[data-degree="MD"]').checked = true;
    doc.getElementById("f-profile-degree-other").value = "MSc";
    doc.getElementById("sheet-save").click();
    await wait(400);
    const degs = JSON.parse(window.eval('JSON.stringify(degreesFor("Nathan Varady"))'));
    check("Ticked degree saved", degs.indexOf("MD") >= 0, degs);
    check("...and the free-text one too", degs.indexOf("MSc") >= 0, degs);
    check("The author list reads correctly",
      window.eval('authorName("Nathan Varady")') === "Nathan Varady, MD, MSc",
      window.eval('authorName("Nathan Varady")'));
    check("Role saved on the profile", window.eval(`profileFor(${JSON.stringify(ME)}).position`) === "Sports medicine fellow");
    check("...and marked as asked", window.eval(`profileFor(${JSON.stringify(ME)}).degreesAsked`) === true);
    window.close();
  }

  console.log("\n-- Answering 'none' is remembered, so nobody is asked twice --");
  {
    const dom = boot(); const { window } = dom, doc = window.document;
    await wait(600);
    await prompt(dom);
    doc.getElementById("f-profile-name").value = "Cade Smelley";
    setSel(doc, "f-profile-position", "Research assistant");
    await wait(80);
    // Tick nothing.
    doc.getElementById("sheet-save").click();
    await wait(400);
    check("No degrees recorded", JSON.parse(window.eval('JSON.stringify(degreesFor("Cade Smelley"))')).length === 0);
    check("But the question is marked answered", window.eval(`profileFor(${JSON.stringify(ME)}).degreesAsked`) === true);
    // Re-running the prompt must now do nothing.
    window.eval("maybePromptDisplayName();");
    await wait(260);
    check("The sheet does NOT reopen", !doc.getElementById("sheet"));
    window.close();
  }

  console.log("\n-- An existing account with a role but no degrees is asked once --");
  {
    const dom = boot({ name: "William Lee", position: "Research assistant" });
    const { window } = dom, doc = window.document;
    await wait(600);
    await prompt(dom);
    check("It asks", !!doc.getElementById("sheet"));
    check("...with the degrees question, not the name", !doc.getElementById("f-profile-name"));
    check("...visible straight away, since the role is already known", shown(doc, "f-profile-degrees"));
    check("...and titled as a degrees question",
      /letters go after your name/i.test(doc.getElementById("sheet").textContent));
    window.close();
  }

  console.log("\n-- A CRCM with a role is never asked for degrees --");
  {
    // alertEmailAsked is set here so this case tests ONE thing. Without it the sheet opens for
    // the alerts question, which is asked of everyone and has nothing to do with degrees.
    const dom = boot({ name: "Carla Edwards", position: "Research manager (CRCM)", alertEmailAsked: true });
    const { window } = dom, doc = window.document;
    await wait(600);
    await prompt(dom);
    check("No sheet at all", !doc.getElementById("sheet"));
    window.close();
  }

  console.log("\n-- Degrees already on file are pre-ticked, and never wiped --");
  {
    const dom = boot({ name: "Adam Yanke", position: "Clinician" }, { "Adam Yanke": ["MD", "PhD"] });
    const { window } = dom, doc = window.document;
    await wait(600);
    await prompt(dom);
    check("It asks, since nobody has recorded an answer from him", !!doc.getElementById("sheet"));
    check("MD is pre-ticked", doc.querySelector('.f-profile-degree[data-degree="MD"]').checked === true);
    check("PhD is pre-ticked", doc.querySelector('.f-profile-degree[data-degree="PhD"]').checked === true);
    check("BS is not", doc.querySelector('.f-profile-degree[data-degree="BS"]').checked === false);
    // Save with nothing ticked at all: the existing pair must survive.
    doc.querySelectorAll(".f-profile-degree").forEach(c => { c.checked = false; });
    doc.getElementById("sheet-save").click();
    await wait(400);
    const degs = JSON.parse(window.eval('JSON.stringify(degreesFor("Adam Yanke"))'));
    check("An empty save does NOT erase what was already there", degs.join(",") === "MD,PhD", degs);
    window.close();
  }

  console.log("\n-- Name and role are still required --");
  {
    const dom = boot(); const { window } = dom, doc = window.document;
    await wait(600);
    await prompt(dom);
    doc.getElementById("f-profile-name").value = "";
    doc.getElementById("sheet-save").click();
    await wait(300);
    check("Blank name is refused, sheet stays open", !!doc.getElementById("sheet"));
    doc.getElementById("f-profile-name").value = "Someone New";
    doc.getElementById("sheet-save").click();
    await wait(300);
    check("Missing role is refused too", !!doc.getElementById("sheet"));
    window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
