// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// A Latest Note column, and choosable columns saved into a shared View.
//
// The Worklist isn't one table — it's several. Chasing enrolment wants different columns from
// chasing manuscripts, and a column that matters for one is noise in the other. Notes were the
// missing one: you had to open thirty studies to read what anyone last said about them.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ME = "11111111-1111-1111-1111-111111111111";
const S1 = "aaaaaaaa-0000-0000-0000-000000000001";
const S2 = "aaaaaaaa-0000-0000-0000-000000000002";
const S3 = "aaaaaaaa-0000-0000-0000-000000000003";

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

const study = (id, title, extra) => ({
  id, kind: "study", updated_at: now,
  data: Object.assign({
    id, title, nickname: title.split(" ")[0], phase: "Data Collection",
    design: "Retrospective (Non-Consented)", irb: "ORA-" + id.slice(-3), irbStatus: "Approved",
    pi: "Adam Yanke", team: [], abstracts: [], docs: [], milestones: [], meetingNotes: [], authors: []
  }, extra || {})
});

function boot(opts) {
  opts = opts || {};
  const items = [
    { id: ME, kind: "profile", updated_at: now,
      data: { id: ME, name: "Adam Yanke", email: "adam.yanke@rushortho.com", position: "Clinician",
              admin: true, reportsTo: "", alertEmail: "", linkedTo: "", alertEmailAsked: true, degreesAsked: true } },
    study(S1, "Meniscal repair outcomes", { noteEntries: [
      { id: "n1", text: "Waiting on the IRB amendment", date: "2026-09-10", archivedOn: "" },
      { id: "n2", text: "Chart review finished for arm A", date: "2026-09-25", archivedOn: "" },
      { id: "n3", text: "Old note nobody needs", date: "2026-09-27", archivedOn: "2026-09-27" }
    ] }),
    study(S2, "Cartilage thickness", { noteEntries: [] }),
    study(S3, "Rotator cuff healing", { noteEntries: [
      { id: "n4", text: "Stats pending from Cat", date: "2026-08-01", archivedOn: "" }
    ] }),
    { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
      data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} } }
  ].concat(opts.extraItems || []);
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.prompt = () => opts.viewName || "My view";
      win.localStorage.setItem("rt-seeded", "1");
      if (opts.storedColumns) win.localStorage.setItem("rt-wl-columns", JSON.stringify(opts.storedColumns));
      win.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
      win.supabase = { createClient: () => {
        const c = makeMockSupabase({ items });
        c.auth.getSession = async () => ({ data: { session: { access_token: "tok", user: { id: ME, email: "adam.yanke@rushortho.com" } } }, error: null });
        return c;
      } };
    }
  });
  return dom;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

async function openWorklist(dom) {
  const { window } = dom;
  await wait(600);
  window.eval(`currentUser = { id: ${JSON.stringify(ME)}, email: "adam.yanke@rushortho.com" }; syncOnline = true;`);
  window.document.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
  await wait(60);
  window.eval(`tab = "worklist"; worklistLayout = "table"; worklistStatus = "all"; worklistPerson = "all"; render();`);
  await wait(250);
  return window;
}
const headers = (win) => [...win.document.querySelectorAll("table.wl thead th")].map(th => th.textContent.replace(/[▲▼]/g, "").trim());
const rowFor = (win, id) => win.document.querySelector(`tr[data-open-study="${id}"]`);
const toastText = (doc) => doc.getElementById("toast").textContent;

(async () => {
  console.log("\n-- The Latest Note column --");
  {
    const dom = boot();
    const win = await openWorklist(dom);
    check("It's a column", headers(win).indexOf("Latest Note") >= 0, headers(win));
    const r1 = rowFor(win, S1).textContent;
    check("It shows the most recent note", /Chart review finished for arm A/.test(r1), r1);
    check("...not an older one", !/Waiting on the IRB amendment/.test(r1));
    check("...and not an archived one, however recent", !/Old note nobody needs/.test(r1));
    check("...with the date it was written", /Sep 25/.test(r1) || /25 Sep/.test(r1), r1);
    check("A study with no notes says so", /No notes/.test(rowFor(win, S2).textContent));
    dom.window.close();
  }

  console.log("\n-- The note isn't truncated --");
  {
    const long = "The coordinator flagged that twelve of the eighteen charts are missing the six-month follow-up, which we need before any of this can be analysed.";
    const dom = boot({ extraItems: [] });
    const win = await openWorklist(dom);
    win.eval(`
      const st = studyById(${JSON.stringify(S2)});
      st.noteEntries = [{ id: "L", text: ${JSON.stringify(long)}, date: "2026-09-26", archivedOn: "" }];
      upsertStudy(st); render();
    `);
    await wait(250);
    check("The whole note is there, not a clipped first line",
      rowFor(win, S2).textContent.indexOf(long) >= 0, rowFor(win, S2).textContent.slice(0, 200));
    dom.window.close();
  }

  console.log("\n-- Sorting by note sorts by when, not by alphabet --");
  {
    const dom = boot();
    const win = await openWorklist(dom);
    const th = [...win.document.querySelectorAll("table.wl thead th")].find(t => /Latest Note/.test(t.textContent));
    th.click();
    await wait(250);
    const order = [...win.document.querySelectorAll("table.wl tbody tr")].map(tr => tr.dataset.openStudy);
    // Ascending: no note (""), then Aug, then Sep.
    check("Oldest-noted first, un-noted before them", order.indexOf(S3) < order.indexOf(S1), order);
    dom.window.close();
  }

  console.log("\n-- Choosing columns --");
  {
    const dom = boot();
    const win = await openWorklist(dom);
    const doc = win.document;
    check("There's a Columns button", !!doc.getElementById("wl-columns"));
    check("...showing how many are on", /Columns \(\d+\)/.test(doc.getElementById("wl-columns").textContent),
      doc.getElementById("wl-columns").textContent);
    doc.getElementById("wl-columns").click();
    await wait(250);
    const picks = [...doc.querySelectorAll(".wl-col-pick")];
    check("Every column is offered", picks.length >= 9, picks.length);
    check("...all ticked to begin with", picks.every(c => c.checked));
    // Keep only nickname, phase and note.
    picks.forEach(c => { c.checked = ["nickname", "phase", "note"].indexOf(c.dataset.key) >= 0; });
    doc.getElementById("sheet-save").click();
    await wait(400);
    const h = headers(win);
    check("Only the chosen columns remain", h.indexOf("IRB Status") < 0 && h.indexOf("Design") < 0, h);
    check("Nickname stayed", h.indexOf("Nickname") >= 0, h);
    check("Latest Note stayed", h.indexOf("Latest Note") >= 0, h);
    check("The Study Team button is still on every row", !!rowFor(win, S1).querySelector("[data-ask-update]"));
    check("...and its header too, since it can't be switched off", h.indexOf("Study Team") >= 0, h);
    check("Header count matches the cells", (() => {
      const ths = doc.querySelectorAll("table.wl thead th").length;
      const tds = doc.querySelector("table.wl tbody tr").children.length;
      return ths === tds;
    })(), [doc.querySelectorAll("table.wl thead th").length, doc.querySelector("table.wl tbody tr").children.length]);
    dom.window.close();
  }

  console.log("\n-- Turning off Nickname doesn't hide the staleness tag --");
  {
    const dom = boot({ storedColumns: ["phase", "note"] });
    const win = await openWorklist(dom);
    // Staleness comes from the sync timestamp (remoteMeta), not from anything on the study — so
    // age it there, which is what a genuinely neglected study looks like.
    win.eval(`remoteMeta[${JSON.stringify(S3)}] = { updated_at: "2026-01-01T00:00:00.000Z" }; render();`);
    await wait(300);
    const t = rowFor(win, S3).textContent;
    check("The tag moved to the status column rather than vanishing", /ROTTEN|STALE/.test(t), t.slice(0, 160));
    dom.window.close();
  }

  console.log("\n-- An empty selection is refused --");
  {
    const dom = boot();
    const win = await openWorklist(dom);
    const doc = win.document;
    doc.getElementById("wl-columns").click();
    await wait(250);
    [...doc.querySelectorAll(".wl-col-pick")].forEach(c => { c.checked = false; });
    doc.getElementById("sheet-save").click();
    await wait(300);
    check("The sheet stays open", !!doc.getElementById("sheet"));
    check("...and says what to do", /at least one column/i.test(toastText(doc)), toastText(doc));
    check("The table is untouched", headers(win).length > 1);
    dom.window.close();
  }

  console.log("\n-- The choice sticks between visits --");
  {
    const dom = boot({ storedColumns: ["title", "phase", "note"] });
    const win = await openWorklist(dom);
    const h = headers(win);
    check("It came back as saved", h.indexOf("IRB Status") < 0 && h.indexOf("IRB Study Name") >= 0, h);
    dom.window.close();
  }
  {
    // A stored key that no longer exists must not leave someone with a blank table.
    const dom = boot({ storedColumns: ["thisColumnWasRetired"] });
    const win = await openWorklist(dom);
    check("An unrecognised saved column falls back to the default set", headers(win).length > 2, headers(win));
    dom.window.close();
  }

  console.log("\n-- A saved View carries its columns to the team --");
  {
    const dom = boot({ viewName: "Manuscript chase" });
    const win = await openWorklist(dom);
    const doc = win.document;
    doc.getElementById("wl-columns").click();
    await wait(250);
    [...doc.querySelectorAll(".wl-col-pick")].forEach(c => { c.checked = ["title", "phase", "note"].indexOf(c.dataset.key) >= 0; });
    doc.getElementById("sheet-save").click();
    await wait(400);
    doc.getElementById("fs-save-worklist").click();
    await wait(400);
    const sets = JSON.parse(win.eval("JSON.stringify(state.filterSets)"));
    const v = sets.find(f => f.name === "Manuscript chase");
    check("The view was saved", !!v, sets);
    check("...with the columns in it", JSON.stringify(v.filters.columns) === JSON.stringify(["title", "phase", "note"]), v.filters.columns);
    check("...and the filters as well", !!v.filters.status);

    // Now wreck the current columns and load the view back.
    win.eval(`setWorklistColumns(["irb"]); render();`);
    await wait(250);
    check("Columns really did change", headers(win).indexOf("Latest Note") < 0, headers(win));
    win.eval(`applyFilters("worklist", ${JSON.stringify({ status: "All", person: "all", phase: "All phases", design: "All designs", search: "", columns: ["title", "phase", "note"] })}); render();`);
    await wait(250);
    const h = headers(win);
    check("Loading the view restores its columns", h.indexOf("Latest Note") >= 0 && h.indexOf("ORA / IRB #") < 0, h);
    dom.window.close();
  }

  console.log("\n-- A view saved before columns existed still works --");
  {
    const dom = boot();
    const win = await openWorklist(dom);
    const before = headers(win).length;
    // No `columns` key at all, as older saved views have.
    win.eval(`applyFilters("worklist", { status: "All", person: "all", phase: "All phases", design: "All designs", search: "" }); render();`);
    await wait(250);
    check("It leaves the columns alone rather than blanking the table",
      headers(win).length === before, [headers(win).length, before]);
    dom.window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", (e && e.stack) ? e.stack : e); process.exit(1); });
