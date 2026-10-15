// Conference deadlines organised by field, and the spine calendar — 15 Oct 2026.
//
// One shared deadline calendar across every lab was always the plan, and it stops being usable the
// moment there are two labs in it: a spine PI should not have to read past forty sports deadlines
// to find NASS. So each meeting has a field, each person subscribes to the fields they submit to,
// and the board groups by field.
//
// The design decision worth protecting is the ORDERING. The board's whole job is answering
// "what's next", and grouping alphabetically would destroy that. Groups are ordered by their own
// soonest deadline instead, so the most urgent field is still at the top — and a lab that tracks
// one field sees exactly one group and no headings at all.
//
// The other thing held here is honesty about the seeded spine dates. Most 2027 spine abstract
// windows have either closed or aren't published yet. Inventing plausible dates would be worse
// than useless: somebody would plan around them.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const USER = "test-user-1";
const now = new Date().toISOString();
const inDays = (n) => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const profile = () => ({
  id: USER, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: { id: USER, email: "test@example.com", name: "Alex Rivera", position: "Clinician",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true, tourSeen: 1, linkedTo: "" },
});
const meeting = (id, society, name, deadline) => ({
  id, kind: "meeting", updated_at: now, workspace: "sports-yanke",
  data: { id, key: society + "|" + name, society, name, type: "abstract", deadline,
    dates: "", location: "", link: "", aim: "", criteria: "", funded: [], studyIds: [],
    unconfirmed: false, verifiedOn: "2026-10-01T09:00" },
});

function boot(items, prefs) {
  const all = items.slice();
  if (prefs) all.push({ id: "pref-row", kind: "userPref", updated_at: now, workspace: "sports-yanke",
    data: Object.assign({ id: USER, name: "Alex Rivera", subs: {} }, prefs) });
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items: all }) };
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
  // Spine deadline sooner than the sports one, so field order and alphabetical order disagree —
  // otherwise the ordering rule would pass by coincidence.
  const items = [
    profile(),
    meeting("m1", "AANA", "2027 Annual Meeting", inDays(60)),
    meeting("m2", "ICRS", "19th World Congress", inDays(90)),
    meeting("m3", "NASS", "42nd Annual Meeting", inDays(20)),
    meeting("m4", "LSRS", "20th Annual Meeting", inDays(40)),
    meeting("m5", "AAOS", "2027 Annual Meeting", inDays(120)),
  ];
  const w = boot(items);
  await wait(600);
  const ev = (c) => w.eval(c);

  console.log("\n-- Every meeting lands in a field --");
  check("spine societies are spine", ev('fieldOf({society:"NASS"})') === "Spine", ev('fieldOf({society:"NASS"})'));
  check("sports societies are sports", ev('fieldOf({society:"ICRS"})') === "Sports medicine");
  check("AAOS is general, not sports", ev('fieldOf({society:"AAOS"})') === "General orthopaedics");
  check("an entry can override its society", ev('fieldOf({society:"NASS", field:"Basic science"})') === "Basic science");
  // An unknown society must land somewhere rather than vanishing off the board.
  check("an unknown society still gets a field",
    ev('fieldOf({society:"Brand New Society"})') === "General orthopaedics");

  console.log("\n-- The board groups by field, soonest field first --");
  ev('tab = "dashboard"; render();');
  await wait(100);
  const heads = [...w.document.querySelectorAll(".field-head")].map(h => h.dataset.field);
  check("there are field headings", heads.length >= 2, heads);
  // Spine's soonest is 20 days; sports' is 60; general is 120. Alphabetically Spine would be last.
  check("Spine leads, because its deadline is soonest", heads[0] === "Spine", heads);
  check("...and General orthopaedics is last", heads[heads.length - 1] === "General orthopaedics", heads);

  console.log("\n-- Inside a field it's still chronological --");
  const firstCard = w.document.querySelector(".field-head + .card");
  const text = firstCard ? firstCard.textContent : "";
  check("NASS is listed before LSRS", text.indexOf("NASS") >= 0 && text.indexOf("NASS") < text.indexOf("LSRS"),
    [text.indexOf("NASS"), text.indexOf("LSRS")]);

  console.log("\n-- A lab that tracks one field sees no headings at all --");
  const spineOnly = boot(items, { fieldSubs: {
    "Sports medicine": false, "General orthopaedics": false, "Shoulder & elbow": false,
    Arthroplasty: false, "Hand & upper extremity": false, "Foot & ankle": false,
    Trauma: false, Pediatrics: false, Oncology: false, "Basic science": false,
  } });
  await wait(600);
  spineOnly.eval('tab = "dashboard"; render();');
  await wait(100);
  check("no field headings", spineOnly.document.querySelectorAll(".field-head").length === 0);
  const board = spineOnly.document.querySelector("#main").textContent;
  check("the spine deadlines are there", /NASS/.test(board) && /LSRS/.test(board));
  check("...and the sports ones are gone", !/ICRS/.test(board) && !/AANA/.test(board), board.slice(0, 300));

  console.log("\n-- Switching a field off is personal and sticks --");
  ev('setFieldSub("Sports medicine", false)');
  await wait(100);
  check("the preference is recorded", ev('fieldSubs()["Sports medicine"]') === false);
  check("...and everything else stays on", ev('fieldSubs()["Spine"]') === true);
  ev('tab = "dashboard"; render();');
  await wait(100);
  check("sports deadlines leave the board",
    !/ICRS/.test(w.document.querySelector("#main").textContent));

  console.log("\n-- The seeded spine calendar is honest about what it knows --");
  const seed = JSON.parse(fs.readFileSync(PROJECT + "/deadlines.json", "utf8")).meetings;
  const spine = seed.filter(m => m.field === "Spine");
  check("the spine societies are seeded", spine.length >= 10, spine.length);
  const socs = spine.map(m => m.society);
  ["NASS", "SRS", "CSRS", "LSRS", "ISSLS", "ISASS", "SMISS", "AO Spine", "AANS/CNS"]
    .forEach(s => check("  " + s + " is there", socs.includes(s), socs));
  // The honesty rule: a date is either published, or absent and flagged. Never guessed.
  const guessed = spine.filter(m => m.deadline && m.unconfirmed);
  check("no entry carries a date it isn't sure of", guessed.length === 0, guessed.map(m => m.society));
  // An empty deadline on the board means "nothing to act on", which is indistinguishable from
  // "we forgot to look". So every undated entry has to say in words WHY it has no date —
  // the window closed, or it hasn't been published. ISASS is the awkward one: its submissions
  // are open but it publishes no closing date, which is worth saying out loud.
  const explains = (m) => /not yet (published|announced)|no closing date is published|closed/i.test(m.dates);
  const undated = spine.filter(m => !m.deadline);
  check("the undated ones explain themselves",
    undated.every(explains), undated.filter(m => !explains(m)).map(m => m.society));
  // Only for the ones whose window hasn't been announced. An entry that simply says "the call
  // closed on X" needs no pointer — the date it's reporting is in the past and final.
  const notYet = undated.filter(m => /not yet (published|announced)|no closing date is published/i.test(m.dates));
  check("...and the not-yet-announced ones say where to look",
    notYet.every(m => /check|contact|watch for/i.test(m.dates)),
    notYet.filter(m => !/check|contact|watch for/i.test(m.dates)).map(m => m.society));
  check("every spine entry links to the society's own page",
    spine.every(m => /^https:\/\//.test(m.link || "")), spine.filter(m => !/^https/.test(m.link || "")).map(m => m.society));

  console.log("\n-- Undated meetings stay off the board, as they always have --");
  // Adam's rule from 2026-08-24: the board is for things that can be acted on. A meeting whose
  // window hasn't opened is real, but it isn't actionable, and it belongs in Settings.
  const withUndated = boot(items.concat([meeting("m6", "CSRS", "55th Annual Meeting", "")]));
  await wait(600);
  withUndated.eval('tab = "dashboard"; render();');
  await wait(100);
  check("it isn't on the board", !/55th Annual Meeting/.test(withUndated.document.querySelector("#main").textContent));
  withUndated.eval('tab = "settings"; render();');
  await wait(150);
  check("...but it is in Settings", /55th Annual Meeting/.test(withUndated.document.querySelector("#main").textContent));

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
