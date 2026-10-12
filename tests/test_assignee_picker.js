// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Multi-assignee tasks already worked; the input didn't. It was one text box with a datalist,
// which autocompletes the first name and then gives up — after "Adam Yanke, " the browser tries
// to match the whole string. So second and third assignees were typed by hand, and a typo meant
// that person was silently unassigned and got no email.
//
// Now it's a tick list, ordered so the common case is one tap: people on the study first, then
// the admins (Adam: "they help manage any study I am part of") who must appear even when they
// aren't named on it, then everyone else.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ME = "11111111-1111-1111-1111-111111111111";
const S1 = "aaaaaaaa-0000-0000-0000-000000000001";
const S2 = "aaaaaaaa-0000-0000-0000-000000000002";

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

const profile = (id, name, extra) => ({ id, kind: "profile", updated_at: now,
  data: Object.assign({ id, name,
    email: id === "p-noemail" ? "" : name.split(" ")[0].toLowerCase() + "@rushortho.com",
    position: "", reportsTo: "", alertEmail: "", linkedTo: "", alertEmailAsked: true, degreesAsked: true }, extra || {}) });

function boot(opts) {
  opts = opts || {};
  const items = [
    profile(ME, "Adam Yanke", { admin: true, position: "Clinician" }),
    // Will and TJ are admins who report to Adam — his own helpers.
    profile("p-will", "William Lee", { admin: true, reportsTo: ME }),
    profile("p-tj", "Thomas Turinske", { admin: true, reportsTo: ME }),
    // Carla reports to Adam but is NOT an admin, so she isn't promoted by that route.
    profile("p-carla", "Carla Edwards", { admin: false, reportsTo: ME }),
    profile("p-dan", "Daniel Shinn", { admin: false }),
    // Another PI, with an admin of their own who must NOT appear in Adam's admin group.
    profile("p-jorge", "Jorge Chahla", { admin: false }),
    profile("p-zach", "Zachary Oppenheim", { admin: true, reportsTo: "p-jorge" }),
    // Has a login, but has chosen a rush.edu notification address — mail there is quarantined,
    // so this must NOT read as a plain green tick.
    profile("p-hannah", "Hannah Reilly", { admin: false, alertEmail: "hannah_reilly@rush.edu" }),
    // A profile with a name but no email at all: the mailer skips these, so no tick.
    profile("p-noemail", "Nora Bell", { admin: false }),
    { id: S1, kind: "study", updated_at: now,
      data: { id: S1, title: "Meniscal repair outcomes", phase: "Enrolling", pi: "Adam Yanke",
              team: ["Carla Edwards"], design: "Prospective", abstracts: [], docs: [], milestones: [], authors: [] } },
    { id: S2, kind: "study", updated_at: now,
      data: { id: S2, title: "Cartilage biomechanics", phase: "Analysis", pi: "Daniel Shinn",
              team: [], design: "Basic science", abstracts: [], docs: [], milestones: [], authors: [] } },
    { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
      data: { id: "00000000-0000-0000-0000-000000000001",
              names: ["Adam Yanke", "William Lee", "Thomas Turinske", "Carla Edwards", "Daniel Shinn",
                      "Jorge Chahla", "Zachary Oppenheim", "Hannah Reilly", "Nora Bell",
                      "Cade Smelley"],
              degrees: {} } }
  ].concat(opts.extraItems || []);
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
      win.supabase = { createClient: () => {
        const c = makeMockSupabase({ items });
        c.auth.getSession = async () => ({ data: { session: { access_token: "tok", user: { id: ME, email: "adam@rushortho.com" } } }, error: null });
        return c;
      } };
    }
  });
  return dom;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

async function signedIn(dom) {
  const { window } = dom;
  await wait(600);
  window.eval(`currentUser = { id: ${JSON.stringify(ME)}, email: "adam@rushortho.com" }; syncOnline = true;`);
  window.document.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
  await wait(60);
}
async function openNewTask(dom, studyId) {
  dom.window.eval(`openTaskForm(null, ${studyId ? JSON.stringify(studyId) : "null"});`);
  await wait(250);
  return dom.window.document;
}
const picks = (doc) => [...doc.querySelectorAll(".f-tassignee-pick")];
const names = (doc) => picks(doc).map(c => c.dataset.name);
const tick = (doc, name) => { const c = picks(doc).find(x => x.dataset.name === name); c.checked = true; return c; };
const headings = (doc) => {
  const box = doc.getElementById("f-tassignee-box");
  return [...box.querySelectorAll("div")].map(d => d.textContent.trim())
    .filter(t => /^(ON THIS STUDY|MY ADMINS|EVERYONE ELSE|ALREADY ON THIS TASK)/.test(t));
};

(async () => {
  console.log("\n-- The old text box is gone, replaced by taps --");
  {
    const dom = boot(); await signedIn(dom);
    const doc = await openNewTask(dom, S1);
    check("No single comma-separated assignee field", !doc.getElementById("f-tassignee"));
    check("A tick list is rendered", picks(doc).length > 0, picks(doc).length);
    check("...and a box for someone not on the list", !!doc.getElementById("f-tassignee-other"));
    check("It says more than one is fine",
      /more than one is fine/i.test(doc.getElementById("sheet").textContent));
    check("...and explains who actually gets emailed",
      /will be emailed/i.test(doc.getElementById("sheet").textContent),
      doc.getElementById("sheet").textContent.slice(0, 240));
    dom.window.close();
  }

  console.log("\n-- Order: study first, then admins, then the rest --");
  {
    const dom = boot(); await signedIn(dom);
    const doc = await openNewTask(dom, S1);
    const h = headings(doc);
    check("Study group comes first", /^ON THIS STUDY/.test(h[0]), h);
    check("My admins come second", /^MY ADMINS/.test(h[1]), h);
    check("Everyone else last", /^EVERYONE ELSE/.test(h[2]), h);

    const order = names(doc);
    // S1: PI Adam Yanke + team Carla Edwards.
    check("The PI is in the study group", order.indexOf("Adam Yanke") === 0, order);
    check("...along with the team member", order.indexOf("Carla Edwards") === 1, order);
    check("Admins follow, even though not on this study",
      order.indexOf("William Lee") > order.indexOf("Carla Edwards")
      && order.indexOf("Thomas Turinske") > order.indexOf("Carla Edwards"), order);
    check("Everyone else is after the admins",
      order.indexOf("Cade Smelley") > order.indexOf("William Lee"), order);
    check("Nobody appears twice", new Set(order.map(n => n.toLowerCase())).size === order.length, order);
    check("Adam isn't repeated under Admins despite being one",
      order.filter(n => n === "Adam Yanke").length === 1, order);
    dom.window.close();
  }

  console.log("\n-- TJ and Will are offered on a study that isn't Adam's --");
  {
    const dom = boot(); await signedIn(dom);
    const doc = await openNewTask(dom, S2);   // PI Daniel Shinn, no team
    const order = names(doc);
    check("The other PI leads", order[0] === "Daniel Shinn", order);
    check("Will is still offered", order.indexOf("William Lee") > 0, order);
    check("TJ is still offered", order.indexOf("Thomas Turinske") > 0, order);
    const h = headings(doc);
    check("...under a heading that says why", /HELP ON ANY STUDY/.test(h.join(" ")), h);
    dom.window.close();
  }

  console.log("\n-- A task with no study still offers admins and everyone --");
  {
    const dom = boot(); await signedIn(dom);
    const doc = await openNewTask(dom, null);
    const h = headings(doc);
    check("No study group", !h.some(x => /^ON THIS STUDY/.test(x)), h);
    check("Admins still offered", names(doc).indexOf("William Lee") >= 0, names(doc));
    check("Everyone else too", names(doc).indexOf("Cade Smelley") >= 0);
    dom.window.close();
  }

  console.log("\n-- Ticking people saves them all --");
  {
    const dom = boot(); await signedIn(dom);
    const doc = await openNewTask(dom, S1);
    doc.getElementById("f-ttitle").value = "Pull the operative notes";
    tick(doc, "Carla Edwards");
    tick(doc, "William Lee");
    tick(doc, "Thomas Turinske");
    doc.getElementById("sheet-save").click();
    await wait(350);
    const saved = JSON.parse(dom.window.eval('JSON.stringify(state.tasks.filter(function(t){return t.title==="Pull the operative notes";})[0] || null)'));
    check("The task saved", !!saved);
    check("All three are assigned", saved && saved.assignees.length === 3, saved && saved.assignees);
    check("...by name", saved && saved.assignees.indexOf("William Lee") >= 0
      && saved.assignees.indexOf("Thomas Turinske") >= 0 && saved.assignees.indexOf("Carla Edwards") >= 0,
      saved && saved.assignees);
    check("The toast names them", /Carla Edwards/.test(doc.getElementById("toast").textContent),
      doc.getElementById("toast").textContent);
    dom.window.close();
  }

  console.log("\n-- More than three collapses to a count rather than a wall of names --");
  {
    const dom = boot(); await signedIn(dom);
    const doc = await openNewTask(dom, S1);
    doc.getElementById("f-ttitle").value = "Big job";
    ["Adam Yanke", "Carla Edwards", "William Lee", "Thomas Turinske"].forEach(n => tick(doc, n));
    doc.getElementById("sheet-save").click();
    await wait(350);
    check("Says how many", /4 people assigned/.test(doc.getElementById("toast").textContent),
      doc.getElementById("toast").textContent);
    dom.window.close();
  }

  console.log("\n-- Someone not on the roster can still be typed in --");
  {
    const dom = boot(); await signedIn(dom);
    const doc = await openNewTask(dom, S1);
    doc.getElementById("f-ttitle").value = "Ask the biostatistician";
    tick(doc, "Adam Yanke");
    doc.getElementById("f-tassignee-other").value = "Priya Raman, Nora Bell";
    doc.getElementById("sheet-save").click();
    await wait(350);
    const saved = JSON.parse(dom.window.eval('JSON.stringify(state.tasks.filter(function(t){return t.title==="Ask the biostatistician";})[0] || null)'));
    check("Typed names are included", saved && saved.assignees.indexOf("Priya Raman") >= 0, saved && saved.assignees);
    check("...both of them", saved && saved.assignees.indexOf("Nora Bell") >= 0, saved && saved.assignees);
    check("...alongside the ticked one", saved && saved.assignees.indexOf("Adam Yanke") >= 0);
    dom.window.close();
  }

  console.log("\n-- The same person twice, two ways, lands once --");
  {
    const dom = boot(); await signedIn(dom);
    const doc = await openNewTask(dom, S1);
    doc.getElementById("f-ttitle").value = "Dedupe check";
    tick(doc, "Carla Edwards");
    doc.getElementById("f-tassignee-other").value = "carla edwards";
    doc.getElementById("sheet-save").click();
    await wait(350);
    const saved = JSON.parse(dom.window.eval('JSON.stringify(state.tasks.filter(function(t){return t.title==="Dedupe check";})[0] || null)'));
    check("Only one entry", saved && saved.assignees.length === 1, saved && saved.assignees);
    dom.window.close();
  }

  console.log("\n-- Editing an existing task pre-ticks who's on it --");
  {
    const TASK = "tttttttt-0000-0000-0000-000000000001";
    const dom = boot({ extraItems: [{ id: TASK, kind: "task", updated_at: now,
      data: { id: TASK, title: "Existing", studyId: S1, due: "", done: false, notes: "",
              assignees: ["Carla Edwards", "Thomas Turinske"] } }] });
    await signedIn(dom);
    dom.window.eval(`openTaskForm(state.tasks.filter(function(t){return t.id==="${TASK}";})[0]);`);
    await wait(250);
    const doc = dom.window.document;
    const checked = picks(doc).filter(c => c.checked).map(c => c.dataset.name);
    check("Both current assignees are ticked",
      checked.length === 2 && checked.indexOf("Carla Edwards") >= 0 && checked.indexOf("Thomas Turinske") >= 0, checked);
    check("Nobody else is", picks(doc).filter(c => c.checked).length === 2);
    // Unticking one and saving must drop just that one.
    picks(doc).find(c => c.dataset.name === "Thomas Turinske").checked = false;
    doc.getElementById("sheet-save").click();
    await wait(350);
    const saved = JSON.parse(dom.window.eval(`JSON.stringify(state.tasks.filter(function(t){return t.id==="${TASK}";})[0])`));
    check("Unticking removes only that person",
      saved.assignees.length === 1 && saved.assignees[0] === "Carla Edwards", saved.assignees);
    dom.window.close();
  }

  console.log("\n-- An off-roster assignee isn't quietly dropped when editing --");
  {
    const TASK = "tttttttt-0000-0000-0000-000000000002";
    const dom = boot({ extraItems: [{ id: TASK, kind: "task", updated_at: now,
      data: { id: TASK, title: "Has an outsider", studyId: S1, due: "", done: false, notes: "",
              assignees: ["Priya Raman"] } }] });
    await signedIn(dom);
    dom.window.eval(`openTaskForm(state.tasks.filter(function(t){return t.id==="${TASK}";})[0]);`);
    await wait(250);
    const doc = dom.window.document;
    check("They're shown", names(doc).indexOf("Priya Raman") >= 0, names(doc));
    check("...and ticked", picks(doc).find(c => c.dataset.name === "Priya Raman").checked === true);
    // Which group they land in is incidental — migrate() folds task assignees into the roster on
    // load, so a freehand name is usually already under "everyone else". The invariant that
    // matters is that they're shown and ticked, which is asserted above.
    check("...in one of the groups, wherever it lands",
      headings(doc).length > 0 && names(doc).indexOf("Priya Raman") >= 0, headings(doc));
    doc.getElementById("sheet-save").click();
    await wait(350);
    const saved = JSON.parse(dom.window.eval(`JSON.stringify(state.tasks.filter(function(t){return t.id==="${TASK}";})[0])`));
    check("Saving without touching anything keeps them", saved.assignees.indexOf("Priya Raman") >= 0, saved.assignees);
    dom.window.close();
  }

  console.log("\n-- Changing the study re-groups without losing ticks --");
  {
    const dom = boot(); await signedIn(dom);
    const doc = await openNewTask(dom, S1);
    tick(doc, "William Lee");
    tick(doc, "Carla Edwards");
    const sel = doc.getElementById("f-tstudy");
    sel.value = S2;
    sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await wait(250);
    const stillChecked = picks(doc).filter(c => c.checked).map(c => c.dataset.name);
    check("Both stay ticked across the change",
      stillChecked.indexOf("William Lee") >= 0 && stillChecked.indexOf("Carla Edwards") >= 0, stillChecked);
    check("The new study's PI now leads the list", names(doc)[0] === "Daniel Shinn", names(doc));
    dom.window.close();
  }

  console.log("\n-- Saving with nobody ticked says so plainly --");
  {
    const dom = boot(); await signedIn(dom);
    const doc = await openNewTask(dom, S1);
    doc.getElementById("f-ttitle").value = "Unassigned for now";
    doc.getElementById("sheet-save").click();
    await wait(350);
    const saved = JSON.parse(dom.window.eval('JSON.stringify(state.tasks.filter(function(t){return t.title==="Unassigned for now";})[0] || null)'));
    check("It still saves", !!saved);
    check("With an empty list, not undefined", saved && Array.isArray(saved.assignees) && saved.assignees.length === 0);
    check("...and says nobody's on it", /nobody assigned/i.test(doc.getElementById("toast").textContent),
      doc.getElementById("toast").textContent);
    dom.window.close();
  }

  console.log("\n-- Only MY admins are promoted, not everyone's --");
  {
    const dom = boot(); await signedIn(dom);
    const { window } = dom;
    const doc = await openNewTask(dom, S1);
    const mine = JSON.parse(window.eval("JSON.stringify(adminsReportingToMe())"));
    check("Will and TJ, who report to Adam", mine.length === 2
      && mine.indexOf("William Lee") >= 0 && mine.indexOf("Thomas Turinske") >= 0, mine);
    check("NOT another PI's admin", mine.indexOf("Zachary Oppenheim") < 0, mine);
    check("NOT a non-admin who reports to Adam", mine.indexOf("Carla Edwards") < 0, mine);
    check("NOT Adam himself", mine.indexOf("Adam Yanke") < 0, mine);

    // The other PI's admin is still assignable — just down in Everyone else, not promoted.
    const order = names(doc);
    check("The other PI's admin is still offered", order.indexOf("Zachary Oppenheim") >= 0, order);
    check("...below Adam's own admins",
      order.indexOf("Zachary Oppenheim") > order.indexOf("William Lee"), order);

    // Re-pointing a reporting line changes this with no code change.
    window.eval(`profileFor("p-dan").admin = true; profileFor("p-dan").reportsTo = ${JSON.stringify(ME)};`);
    const after = JSON.parse(window.eval("JSON.stringify(adminsReportingToMe())"));
    check("A newly promoted direct report appears on their own", after.indexOf("Daniel Shinn") >= 0, after);
    window.eval(`profileFor("p-zach").reportsTo = ${JSON.stringify(ME)};`);
    const after2 = JSON.parse(window.eval("JSON.stringify(adminsReportingToMe())"));
    check("...and so does one moved under Adam", after2.indexOf("Zachary Oppenheim") >= 0, after2);
    dom.window.close();
  }

  console.log("\n-- Signed in as someone with no direct reports --");
  {
    const dom = boot(); await signedIn(dom);
    const { window } = dom;
    window.eval(`currentUser = { id: "p-jorge", email: "jorge@rushortho.com" };`);
    const doc = await openNewTask(dom, S1);
    const mine = JSON.parse(window.eval("JSON.stringify(adminsReportingToMe())"));
    check("Jorge sees his own admin", mine.indexOf("Zachary Oppenheim") >= 0, mine);
    check("...and not Adam's", mine.indexOf("William Lee") < 0, mine);
    check("Everyone is still assignable", names(doc).indexOf("William Lee") >= 0, names(doc));
    dom.window.close();
  }

  console.log("\n-- A green tick marks who will actually be emailed --");
  {
    const dom = boot(); await signedIn(dom);
    const doc = await openNewTask(dom, S1);
    const stateFor = (name) => {
      const row = picks(doc).find(c => c.dataset.name === name).closest(".assignee-row");
      const el = row.querySelector(".asg-mail");
      return el && el.dataset.state;
    };
    check("Someone with a login gets a green tick", stateFor("Carla Edwards") === "ok", stateFor("Carla Edwards"));
    check("...as does an admin with a login", stateFor("William Lee") === "ok", stateFor("William Lee"));
    check("Cade, who has no account, is marked no-login", stateFor("Cade Smelley") === "none", stateFor("Cade Smelley"));
    check("A profile with no email address also counts as no-login",
      stateFor("Nora Bell") === "none", stateFor("Nora Bell"));
    check("A rush.edu notification address is NOT a plain green tick",
      stateFor("Hannah Reilly") === "filtered", stateFor("Hannah Reilly"));

    const box = doc.getElementById("f-tassignee-box");
    check("The green marker is a tick", /✓/.test(box.textContent));
    check("...and no-login says so in words", /no login/.test(box.textContent));
    check("The legend explains the tick",
      /green .{0,20}✓.{0,40}login/is.test(doc.getElementById("sheet").innerHTML.replace(/<[^>]+>/g, " ")),
      doc.getElementById("sheet").textContent.slice(0, 300));

    // The tick must reflect the address the mailer would really use, not just the sign-in one.
    const okRow = picks(doc).find(c => c.dataset.name === "Carla Edwards").closest(".assignee-row");
    check("The tick names the address it would go to",
      /carla@rushortho\.com/.test(okRow.querySelector(".asg-mail").getAttribute("title")),
      okRow.querySelector(".asg-mail").getAttribute("title"));
    dom.window.close();
  }

  console.log("\n-- It follows the person's chosen alert address --");
  {
    const dom = boot(); await signedIn(dom);
    const { window } = dom;
    let doc = await openNewTask(dom, S1);
    const stateFor = (d, name) => {
      const c = picks(d).find(x => x.dataset.name === name);
      return c.closest(".assignee-row").querySelector(".asg-mail").dataset.state;
    };
    check("Carla starts as emailable", stateFor(doc, "Carla Edwards") === "ok");
    // She switches her notifications to a quarantined domain.
    window.eval(`profileFor("p-carla").alertEmail = "carla.edwards@rush.edu";`);
    window.eval("closeSheet();");
    await wait(320);
    doc = await openNewTask(dom, S1);
    check("...and now reads as filtered, not green", stateFor(doc, "Carla Edwards") === "filtered",
      stateFor(doc, "Carla Edwards"));
    dom.window.close();
  }

  console.log("\n-- Saving warns about anyone who won't be emailed --");
  {
    const dom = boot(); await signedIn(dom);
    const doc = await openNewTask(dom, S1);
    doc.getElementById("f-ttitle").value = "Chase the consent forms";
    tick(doc, "Carla Edwards");
    tick(doc, "Cade Smelley");
    doc.getElementById("sheet-save").click();
    await wait(350);
    const t = doc.getElementById("toast").textContent;
    check("It names who won't be emailed", /No email for Cade Smelley/.test(t), t);
    check("...and says why", /no login/i.test(t), t);
    check("...and what to do instead", /tell them directly/i.test(t), t);
    check("It doesn't wrongly include the one who will be emailed", !/No email for Carla/.test(t), t);
    dom.window.close();
  }

  console.log("\n-- No warning when everyone has a login --");
  {
    const dom = boot(); await signedIn(dom);
    const doc = await openNewTask(dom, S1);
    doc.getElementById("f-ttitle").value = "All covered";
    tick(doc, "Carla Edwards");
    tick(doc, "William Lee");
    doc.getElementById("sheet-save").click();
    await wait(350);
    check("Nothing about missing email", !/No email for/.test(doc.getElementById("toast").textContent),
      doc.getElementById("toast").textContent);
    dom.window.close();
  }

  console.log("\n-- The check mirrors what the mailer actually does --");
  {
    const te = fs.readFileSync(PROJECT + "/supabase/functions/task-emails/index.ts", "utf8");
    check("The mailer skips linked spares, and so must the tick", /p\.linkedTo/.test(te));
    check("The mailer requires a name AND an email", /!p\?\.email \|\| !p\?\.name/.test(te));
    check("The mailer keys on canonName", /canonName\(p\.name\)/.test(te));
    check("...and the app's check is documented as mirroring it",
      /mirrors what task-emails/.test(html));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
