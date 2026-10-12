// Teaching Cases (cases/index.html) — jsdom checks.
// Run: node test_teaching_cases.js [path-to-cases/index.html]
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const FILE = process.argv[2] || path.join(__dirname, "..", "cases", "index.html");
const html = fs.readFileSync(FILE, "utf8");

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 400) : "")); }
}
const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));

// ---- In-memory Supabase stand-in: teaching_cases, case_access, items(profile) + patch_case ----
function makeDB(userId, role) {
  const db = {
    teaching_cases: [], seq: 0,
    case_access: role ? [{ user_id: userId, email: "me@rushortho.com", name: "Me", role }] : [],
    items: [
      { id: userId, kind: "profile", data: { name: "Adam Yanke", email: "adam.yanke@rushortho.com" } },
      { id: "u-ra", kind: "profile", data: { name: "William Lee", email: "william.lee@rushortho.com" } }
    ],
    rpcLog: []
  };
  function canEdit() { const r = db.case_access.find(x => x.user_id === userId); return r && ["editor", "owner"].includes(r.role); }
  function canView() { const r = db.case_access.find(x => x.user_id === userId); return r && ["viewer", "editor", "owner"].includes(r.role); }
  function builder(table) {
    let rows = null, filtersEq = [], op = "select", payload = null, single = false, maybe = false, wantSelect = false;
    const b = {
      select() { wantSelect = true; return b; },
      eq(k, v) { filtersEq.push([k, v]); return b; },
      order() { return b; },
      insert(p) { op = "insert"; payload = p; return b; },
      update(p) { op = "update"; payload = p; return b; },
      single() { single = true; return b; },
      maybeSingle() { maybe = true; return b; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); }
    };
    function match(r) { return filtersEq.every(([k, v]) => r[k] === v); }
    function run() {
      const T = db[table];
      if (op === "insert") {
        if (table === "teaching_cases" && !canEdit()) return { data: null, error: { message: "RLS" } };
        if (table === "case_access") {
          const owner = db.case_access.some(r => r.user_id === userId && r.role === "owner");
          if (!owner && !(payload.user_id === userId && payload.role === "requested")) return { data: null, error: { message: "RLS" } };
        }
        const row = Object.assign({}, payload);
        if (table === "teaching_cases") Object.assign(row, { id: "c" + (++db.seq), case_no: db.seq, archived: false, updated_at: new Date().toISOString(), data: JSON.parse(JSON.stringify(payload.data)) });
        T.push(row);
        return { data: single ? row : [row], error: null };
      }
      if (op === "update") {
        T.filter(match).forEach(r => Object.assign(r, payload));
        return { data: null, error: null };
      }
      if (table === "teaching_cases" && !canView()) return { data: [], error: null };
      rows = T.filter(match);
      if (maybe || single) return { data: rows[0] || null, error: null };
      return { data: rows, error: null };
    }
    return b;
  }
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: userId, email: "adam.yanke@rushortho.com" } } } }),
      onAuthStateChange() {}, signOut: async () => ({})
    },
    from: builder,
    rpc: async (fn, args) => {
      db.rpcLog.push(JSON.parse(JSON.stringify(args)));
      if (!canEdit()) return { data: null, error: { message: "RLS" } };
      const r = db.teaching_cases.find(x => x.id === args.case_id);
      const p = args.patch || {};
      const rest = Object.assign({}, p); delete rest.events;
      r.data = Object.assign({}, r.data, rest);
      if (p.events) r.data.events = Object.assign({}, r.data.events || {}, p.events);
      if (args.set_archived != null) r.archived = args.set_archived;
      return { data: JSON.parse(JSON.stringify(r)), error: null };
    },
    channel() { const ch = { on() { return ch; }, subscribe() { return ch; } }; return ch; }
  };
  return { db, client };
}

async function boot(role) {
  const ME = "11111111-1111-1111-1111-111111111111";
  const { db, client } = makeDB(ME, role);
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: "https://rushsportsresearch.netlify.app/cases/",
    beforeParse(w) { w.__CASES_TEST__ = true; w.supabase = { createClient: () => client }; w.scrollTo = () => {}; }
  });
  const w = dom.window;
  w.eval("boot()");
  await tick(30);
  return { w, db, doc: w.document };
}
function click(w, el) { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); }
function setVal(w, id, v) { const el = w.document.getElementById(id); el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); el.dispatchEvent(new w.Event("change", { bubbles: true })); }

(async () => {
  console.log("Owner flow");
  let { w, db, doc } = await boot("owner");
  check("app shown for owner", !doc.getElementById("app").classList.contains("hidden"));
  check("Access tab visible to owner", /Access/.test(doc.getElementById("tabs").textContent));
  check("empty state", /No teaching cases yet/.test(doc.getElementById("main").textContent));

  // New case with real dates
  click(w, doc.getElementById("new-case-btn"));
  setVal(w, "cf-title", "Recurrent instability with dysplasia");
  setVal(w, "cf-op", "MPFL reconstruction");
  setVal(w, "cf-region", "Knee");
  setVal(w, "cf-age", "20s");
  setVal(w, "cf-dos", "2024-03-15");
  setVal(w, "cf-visit", "2024-02-14");
  setVal(w, "cf-dos2", "2024-10-01");
  setVal(w, "cf-ind", "Yes");
  click(w, doc.getElementById("cf-save"));
  await tick(20);
  check("case created", db.teaching_cases.length === 1);
  const c1 = db.teaching_cases[0];
  const blob = JSON.stringify(c1);
  check("no real dates stored", !/2024-0[23]-1[45]|2024-10-01|3\/15|2\/14/.test(blob), blob);
  check("surgery year kept", c1.data.surgeryYear === 2024);
  const days = Object.values(c1.data.events).map(e => e.day).sort((a, b) => a - b);
  check("events converted to days from surgery", JSON.stringify(days) === JSON.stringify([-30, 0, 200]), days);
  check("index surgery flagged", Object.values(c1.data.events).some(e => e.index && e.day === 0));
  check("routed to case page", /CASE-0001/.test(doc.getElementById("main").textContent));
  check("timeline rendered", doc.querySelectorAll("#main .tl-svg .tl-hit").length === 3);
  check("legend shown", /Clinic visit/.test(doc.querySelector(".legend").textContent));
  check("toast mentions key sheet", /key sheet/.test(doc.getElementById("toast").textContent));

  // Add an event by interval
  click(w, doc.getElementById("add-ev"));
  // DOS remembered this session → date mode preselected; switch to interval
  click(w, doc.querySelector('#ef-mode [data-m="interval"]'));
  setVal(w, "ef-type", "outcome");
  setVal(w, "ef-label", "1-year PROMs");
  setVal(w, "ef-n", "1"); setVal(w, "ef-unit", "years"); setVal(w, "ef-dir", "after");
  click(w, doc.getElementById("ef-save"));
  await tick(20);
  const ev1 = Object.values(db.teaching_cases[0].data.events);
  check("interval event added at +365", ev1.some(e => e.type === "outcome" && e.day === 365));
  check("earlier events kept (merge)", ev1.length === 4);
  check("patch sent only the new event", Object.keys(db.rpcLog[db.rpcLog.length - 1].patch.events).length === 1);

  // Add event by dates — DOS is remembered in memory, never stored
  click(w, doc.getElementById("add-ev"));
  check("date mode preselected when DOS known this visit", !doc.getElementById("ef-date").classList.contains("hidden"));
  check("DOS prefilled from this visit", doc.getElementById("ef-dos").value === "2024-03-15");
  setVal(w, "ef-when", "2024-04-26");
  setVal(w, "ef-type", "visit");
  click(w, doc.getElementById("ef-save"));
  await tick(20);
  check("date event stored as +42", Object.values(db.teaching_cases[0].data.events).some(e => e.day === 42));
  check("still no real dates stored", !/2024-04-26|2024-03-15/.test(JSON.stringify(db.teaching_cases)));
  check("no dates in localStorage", !/2024/.test(JSON.stringify(Object.assign({}, w.localStorage))));

  // PHI tripwire on a section
  click(w, doc.querySelector('[data-edit-sec="history"]'));
  doc.getElementById("sec-ta").value = "Seen 3/4/2024 by Mr. Smith, MRN 12345678";
  click(w, doc.getElementById("sec-save"));
  await tick(10);
  check("PHI warning shown", /Check for PHI/.test(doc.getElementById("sec-warn").textContent));
  check("not saved on first click", !db.teaching_cases[0].data.history);
  check("warning names a date and MRN", /date/.test(doc.getElementById("sec-warn").textContent) && /MRN|record|long number/.test(doc.getElementById("sec-warn").textContent));
  doc.getElementById("sec-ta").value = "Two years of instability, failed PT x6 months.";
  click(w, doc.getElementById("sec-save"));
  await tick(10);
  // override flag was set by the first click; clean text should save too
  check("clean history saved", db.teaching_cases[0].data.history === "Two years of instability, failed PT x6 months.");

  // Workflow toggles
  click(w, doc.querySelector('[data-flag="photosPulled"]'));
  await tick(10);
  check("photos pulled saved", db.teaching_cases[0].data.photosPulled === true);

  // Folder link warning
  click(w, doc.getElementById("edit-folder"));
  setVal(w, "ff-url", "https://www.dropbox.com/s/abc");
  check("non-Rush link warned", /Rush/.test(doc.getElementById("ff-warn").textContent));
  setVal(w, "ff-url", "https://rushortho-my.sharepoint.com/:f:/g/personal/x/CASE-0001");
  check("sharepoint link accepted", doc.getElementById("ff-warn").textContent === "");
  click(w, doc.getElementById("ff-save"));
  await tick(10);
  check("folder saved", /sharepoint/.test(db.teaching_cases[0].data.folderUrl));
  check("open link opens new tab safely", doc.getElementById("open-folder").getAttribute("rel").includes("noopener"));

  // Archive with undo
  click(w, doc.getElementById("archive-btn"));
  await tick(10);
  check("archived (not deleted)", db.teaching_cases.length === 1 && db.teaching_cases[0].archived === true);

  // Remove event = archive flag
  const evId = Object.keys(db.teaching_cases[0].data.events).find(k => db.teaching_cases[0].data.events[k].day === 42);
  w.eval(`openEventForm(cases[0], "${evId}")`);
  click(w, doc.getElementById("ef-remove"));
  await tick(10);
  check("removed event kept but archived", db.teaching_cases[0].data.events[evId].archived === true);
  check("archived event hidden from timeline", !w.eval("liveEvents(cases[0])").some(e => e.id === evId));

  // Board
  await w.eval("patchCase(cases[0].id, {}, false)"); await tick(5);
  w.eval('go("board")'); await tick(5);
  check("board shows card in Media pulled", /CASE-0001/.test(doc.querySelector('.col[data-stage="media"]').textContent));
  click(w, doc.querySelector("[data-next]"));
  await tick(10);
  check("Next moves to drafted", db.teaching_cases[0].data.presentationDrafted === true);

  // Journeys
  w.eval('go("journeys")'); await tick(5);
  check("journeys lane rendered", doc.querySelectorAll("#main .tl-lane-lbl").length === 1);

  // Import
  console.log("Import");
  const csv = [
    "Patient,MRN,Indications Conf?,RA Responsible,primary op,DOS,DOS 2,DOS 3,Date of Visit,Pulled photos/vids?,Presentation drafted",
    "Jane Doe,98765432,Y,William Lee,Osteochondral allograft (OCA),5/2/2023,,,4/1/2023,Y,",
    '"Smith, John",11223344,,,MACI / ACI,45200,,,,,Y',
    ",,,,,,,,,,"
  ].join("\n");
  const rows = w.eval("parseCSV")(csv);
  check("csv parsed with quoted comma", rows[2][0] === "Smith, John");
  const imp = w.eval("rowsToImport")(rows);
  check("recognised all sheet columns", ["patient", "mrn", "indicationsConf", "raResponsible", "primaryOp", "dos", "dos2", "dos3", "visit", "photosPulled", "presentationDrafted"].every(k => imp.map[k] != null), imp.map);
  check("blank-ish row skipped", imp.items.length === 2);
  check("visit converted (-31)", Object.values(imp.items[0].data.events).some(e => e.day === -31));
  check("excel serial date read", imp.items[1].data.surgeryYear === 2023);
  check("Y → indications Yes / photos pulled", imp.items[0].data.indicationsConf === "Yes" && imp.items[0].data.photosPulled === true);
  check("import data carries no patient/MRN", !/Jane|Doe|98765432|Smith|11223344/.test(JSON.stringify(imp.items.map(i => i.data))));

  w.eval("go('cases')"); await tick(5);
  w.eval("openImport()");
  w.eval(`importState = rowsToImport(parseCSV(${JSON.stringify(csv)})); renderImportPreview();`);
  check("preview hides names", !/Jane|98765432/.test(doc.getElementById("imp-preview").textContent));
  let blobText = null;
  w.URL.createObjectURL = (b) => { const fr = new w.FileReader(); fr.onload = () => blobText = fr.result; fr.readAsText(b); return "blob:x"; };
  await w.eval("runImport()");
  await tick(30);
  check("two cases imported", db.teaching_cases.length === 3);
  check("database never received patient/MRN", !/Jane|Doe|98765432|Smith|11223344/.test(JSON.stringify(db)));
  check("key sheet built locally with names + case ids", blobText && /CASE-0002,Jane Doe,98765432,5\/2\/2023/.test(blobText) && /CASE-0003,"Smith, John"/.test(blobText), blobText);

  // Re-import with Case ID updates instead of duplicating
  const csv2 = ["Case ID,primary op,Presentation drafted", "CASE-0002,Osteochondral allograft (OCA),Y"].join("\n");
  w.eval("openImport()");
  w.eval(`importState = rowsToImport(parseCSV(${JSON.stringify(csv2)})); renderImportPreview();`);
  await w.eval("runImport()"); await tick(20);
  check("Case ID row updated, not duplicated", db.teaching_cases.length === 3 && db.teaching_cases[1].data.presentationDrafted === true);
  check("update kept existing timeline", Object.keys(db.teaching_cases[1].data.events).length === 2);

  // Access admin
  w.eval('go("access")'); await tick(5);
  check("access page lists teammate to add", /William Lee/.test(doc.getElementById("main").textContent));
  setVal(w, "add-person", "u-ra"); setVal(w, "add-role", "editor");
  click(w, doc.getElementById("add-go")); await tick(20);
  check("access granted as editor", db.case_access.some(r => r.user_id === "u-ra" && r.role === "editor"));

  // Helpers
  check("fmtRel weeks", w.eval("fmtRel(42)") === "+6 wk");
  check("fmtRel before", w.eval("fmtRel(-30)") === "−4 wk");
  check("fmtRel years", w.eval("fmtRel(730)") === "+2 yr");
  check("scanPHI clean text passes", w.eval("scanPHI('KOOS 82 at 1 year, TT-TG 22 mm, 2019 surgery').length") === 0);
  check("scanPHI catches month-day", w.eval("scanPHI('seen on March 4').length") === 1);

  console.log("No access");
  ({ w, db, doc } = await boot(null));
  check("no-access screen shown", !doc.getElementById("noaccess").classList.contains("hidden") && doc.getElementById("app").classList.contains("hidden"));
  click(w, doc.getElementById("request-btn")); await tick(20);
  check("request recorded", db.case_access.some(r => r.role === "requested"));
  check("button shows sent", /sent/i.test(doc.getElementById("request-btn").textContent));

  console.log("Viewer");
  ({ w, db, doc } = await boot("viewer"));
  db.teaching_cases.push({ id: "v1", case_no: 9, archived: false, data: { title: "Viewer case", events: { a: { type: "surgery", day: 0 } } } });
  await w.eval("loadCases()"); w.eval("render()");
  check("viewer: no new-case button", doc.getElementById("new-case-btn").classList.contains("hidden"));
  check("viewer: no Access tab", !/Access/.test(doc.getElementById("tabs").textContent));
  w.eval('go("cases","v1")'); await tick(5);
  check("viewer: no edit controls", !doc.getElementById("edit-details") && !doc.getElementById("add-ev"));
  check("viewer: case readable", /Viewer case/.test(doc.getElementById("main").textContent));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
