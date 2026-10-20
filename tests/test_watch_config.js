// Each lab configures its own research feed — 20 Oct 2026.
//
// Step one of replacing the hand-built watch files: a per-lab record saying whose work to follow,
// which topics, which societies. A PI edits their own — Adam has no business choosing Singh's
// spine keywords, and Singh should not have to ask.
//
// The things worth pinning:
//
//   1. The row id is DERIVED FROM THE LAB. Somebody in two labs must pick up the right config,
//      not whichever row happened to arrive first in the pull.
//
//   2. It saves to the lab it belongs to. A config stamped with the wrong workspace would either
//      vanish behind RLS or, worse, configure somebody else's feed.
//
//   3. The institution field exists for a specific reason — disambiguating a common surname. The
//      publication import already collected 17 papers belonging to a veterinarian once, so the
//      field's purpose is explained in the UI rather than left to be guessed.
//
//   4. Free text survives the round trip. People type "a, b , ,c" and expect three items.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const USER = "test-user-1";
const now = new Date().toISOString();
const profile = (ws) => ({
  id: USER, kind: "profile", updated_at: now, workspace: ws,
  data: { id: USER, email: "k@example.com", name: "Kern Singh", position: "Clinician",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true,
    tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: true },
});

function boot(ws, extraItems) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
      win.supabase = { createClient: () => makeMockSupabase({
        items: [profile(ws)].concat(extraItems || []) }) };
    },
  });
  return dom.window;
}

const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}

(async () => {
  const w = boot("spine-singh");
  await wait(700);
  const ev = (c) => w.eval(c);

  console.log("\n-- The row id follows the lab --");
  const a = ev('watchConfigRowId("spine-singh")');
  const b = ev('watchConfigRowId("sports-yanke")');
  check("two labs get two ids", a !== b, { a, b });
  check("the same lab gets the same id twice", a === ev('watchConfigRowId("spine-singh")'));
  check("it looks like a row id", /^[0-9a-f-]{36}$/.test(a), a);
  check("no lab falls back to the first workspace",
    ev('watchConfigRowId("")') === ev('watchConfigRowId("sports-yanke")'));

  console.log("\n-- A lab with no config gets a usable blank --");
  const blank = JSON.parse(ev('JSON.stringify(blankWatchConfig("spine-singh"))'));
  check("it carries its lab", blank.workspace === "spine-singh", blank.workspace);
  check("...and the matching id", blank.id === a);
  ["authors", "excludeAuthors", "keywords", "excludeKeywords", "societies"].forEach(k =>
    check("  " + k + " is an array", Array.isArray(blank[k]), blank[k]));
  check("institution is a string", typeof blank.institution === "string");
  check("it starts enabled", blank.enabled === true);
  check("watchConfig() returns the blank when nothing is stored",
    ev("JSON.stringify(watchConfig().authors)") === "[]");

  console.log("\n-- Saving writes this lab's row, with this lab's stamp --");
  ev('myWorkspace = "spine-singh"; state.watchConfig = null;');
  await ev(`openWatchSettingsSheet()`);
  await wait(300);
  check("the sheet opened", !!w.document.getElementById("wc-authors"));
  check("the institution field explains why it exists",
    /veterinarian/.test(w.document.getElementById("main").innerHTML)
    || /veterinarian/.test(w.document.body.innerHTML));
  // Type like a person: ragged spacing, a stray comma, mixed case.
  w.document.getElementById("wc-authors").value = "Kern Singh , Arash Sayari ,, ";
  w.document.getElementById("wc-institution").value = "  Rush University Medical Center ";
  w.document.getElementById("wc-keywords").value = "cervical disc replacement, MCID,,lumbar decompression";
  w.document.getElementById("wc-exclude-authors").value = "";
  w.document.getElementById("wc-exclude-keywords").value = "case report";
  w.document.getElementById("wc-societies").value = "AANS/CNS, NASS";
  const save = w.document.getElementById("sheet-save");
  check("there is a save button", !!save);
  save.click();
  await wait(400);

  const saved = JSON.parse(ev("JSON.stringify(state.watchConfig)"));
  check("authors parsed, blanks dropped",
    JSON.stringify(saved.authors) === '["Kern Singh","Arash Sayari"]', saved.authors);
  check("institution trimmed", saved.institution === "Rush University Medical Center", saved.institution);
  check("keywords parsed, empty entry dropped",
    JSON.stringify(saved.keywords) === '["cervical disc replacement","MCID","lumbar decompression"]', saved.keywords);
  check("an empty field becomes an empty array",
    Array.isArray(saved.excludeAuthors) && saved.excludeAuthors.length === 0, saved.excludeAuthors);
  check("societies parsed", JSON.stringify(saved.societies) === '["AANS/CNS","NASS"]', saved.societies);
  check("it is stamped with this lab", saved.workspace === "spine-singh", saved.workspace);
  check("...and carries this lab's row id", saved.id === a, saved.id);
  check("still enabled", saved.enabled === true);

  console.log("\n-- It is pushed as its own kind, keyed by the derived id --");
  check("pushed as watchConfig", /pushItem\("watchConfig", next, next\.id\)/.test(html));
  check("realtime updates are applied", /kind === "watchConfig"\) \{ state\.watchConfig = data/.test(html));
  check("the pull matches on the lab's row id",
    /kind === "watchConfig" && r\.id === watchConfigRowId\(ws\)/.test(html));

  console.log("\n-- The empty Research tab tells you what to do --");
  ev('state.watchConfig = null; watchData = null; tab = "research"; render();');
  let out = w.document.getElementById("main").innerHTML;
  check("it points at the settings", /Settings → My research feed/.test(out));
  check("...and says why it is empty rather than borrowed",
    /rather than showing you/.test(out));
  // Once configured, the message changes: there is nothing for the user to do but wait.
  ev(`state.watchConfig = { id: "x", workspace: "spine-singh", authors: ["Kern Singh"],
      institution: "", excludeAuthors: [], keywords: [], excludeKeywords: [], societies: [],
      enabled: true, lastRunAt: "" }; render();`);
  out = w.document.getElementById("main").innerHTML;
  check("a configured lab is told to wait, not to configure",
    /next refresh will fill this in/.test(out) && !/Settings → My research feed/.test(out));

  console.log("\n-- Two labs don't share one config --");
  const wTwo = boot("sports-yanke", [{
    id: null, kind: "watchConfig", updated_at: now, workspace: "spine-singh",
    data: { id: "zzz", workspace: "spine-singh", authors: ["Kern Singh"], institution: "",
      excludeAuthors: [], keywords: [], excludeKeywords: [], societies: [], enabled: true, lastRunAt: "" },
  }]);
  await wait(700);
  // The seeded row belongs to spine-singh; sports-yanke must not adopt it as its own id.
  check("a foreign config is not treated as mine",
    wTwo.eval('watchConfig().id') !== "zzz" || wTwo.eval('watchConfig().workspace') !== "spine-singh"
    || wTwo.eval('myWorkspace') === "spine-singh",
    { id: wTwo.eval('watchConfig().id'), ws: wTwo.eval('myWorkspace') });
  wTwo.close();

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
