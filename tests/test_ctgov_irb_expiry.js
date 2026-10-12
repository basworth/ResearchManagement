// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Two things a prospective study can lose that no amount of later effort recovers: registering
// on ClinicalTrials.gov after the first patient (journals can refuse the paper), and letting IRB
// continuing review lapse while still enrolling (reportable). Both now have to be visible
// without a click, and neither may quietly overwrite a deliberate choice.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
// LOCAL calendar date, matching the app. toISOString() is UTC, which after 7pm Chicago already
// reports tomorrow — the exact off-by-one the app itself had.
const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p2 = (x) => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
};

const mk = (id, extra) => ({ id, kind: "study", data: Object.assign({
  id, title: id, nickname: id, pi: "Adam Yanke", team: [], design: "Prospective (Consented)",
  phase: "Enrolling", priority: "Medium", irb: "ORA-" + id, milestones: [],
  enrollTarget: 100, enrollCurrent: 40
}, extra || {}), updated_at: now });

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

function boot(items, metaExtra) {
  const meta = Object.assign({ id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} }, metaExtra || {});
  const all = items.concat([{ id: meta.id, kind: "meta", data: meta, updated_at: now }]);
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items: all }) };
    }
  });
  return dom;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---------------------------------------------------------------- ClinicalTrials.gov stage
  console.log("\n-- ClinicalTrials.gov is a tracked stage, ahead of activation --");
  {
    const { window } = boot([mk("a", { phase: "Initiation" })]), doc = window.document;
    await wait(500);
    window.eval('upsertProfile("Adam Yanke"); syncOnline = true;');
    await wait(60);
    const keys = JSON.parse(window.eval("JSON.stringify(initiationStages().map(s => s.key))"));
    check("The stage exists", keys.indexOf("ctgov") >= 0, keys);
    check("...before site activation", keys.indexOf("ctgov") < keys.indexOf("activation"), keys);
    check("...and before the site initiation visit", keys.indexOf("ctgov") < keys.indexOf("siv"), keys);
    check("Its label says when it's due",
      /before first enrol/i.test(window.eval('initiationStages().find(s => s.key === "ctgov").label')),
      window.eval('initiationStages().find(s => s.key === "ctgov").label'));
    window.close();
  }

  console.log("\n-- The NCT number is recorded and links out --");
  {
    const { window } = boot([mk("a", { nct: "NCT01234567" })]), doc = window.document;
    await wait(500);
    window.eval('upsertProfile("Adam Yanke"); syncOnline = true; tab = "studies"; openStudy("a"); render();');
    await wait(150);
    const h = doc.getElementById("main").innerHTML;
    check("Shown on the study page", h.indexOf("NCT01234567") > 0);
    check("...as a link to the registry", /clinicaltrials\.gov\/study\/NCT01234567/.test(h));
    // openStudyForm takes the study object, not its id.
    check("The edit form carries the field", (window.eval('openStudyForm(studyById("a"))'), true));
    await wait(150);
    check("...pre-filled", doc.getElementById("f-nct").value === "NCT01234567", doc.getElementById("f-nct").value);
    check("...and an IRB expiry field sits alongside it", !!doc.getElementById("f-irb-expiry"));
    window.close();
  }

  console.log("\n-- Enrolling without registration is called out; N/A silences it --");
  {
    const { window } = boot([
      mk("unreg", {}),
      mk("done", { initiationProgress: { ctgov: { status: "Passed", submitted: day(-40), passed: day(-30) } } }),
      mk("na", { initiationProgress: { ctgov: { status: "N/A" } } }),
      mk("early", { phase: "Initiation" })
    ]);
    const doc = window.document;
    await wait(500);
    window.eval('upsertProfile("Adam Yanke"); syncOnline = true;');
    await wait(60);
    const warnOn = async (id) => {
      window.eval(`tab = "studies"; openStudy("${id}"); render();`);
      await wait(140);
      return /Enrolling without ClinicalTrials\.gov/.test(doc.getElementById("main").innerHTML);
    };
    check("An enrolling study with no registration is warned about", await warnOn("unreg"));
    check("A registered study is not", !(await warnOn("done")));
    check("An N/A study is not — it genuinely doesn't apply", !(await warnOn("na")));
    check("A study still in Initiation is not — it isn't late yet", !(await warnOn("early")));
    window.close();
  }

  console.log("\n-- A stage someone deliberately removed stays removed --");
  {
    // A customised list from before ctgov existed. It should gain the stage once...
    const custom = [{ key: "irb", label: "IRB approval" }, { key: "activation", label: "Site activation / first patient in" }];
    const { window } = boot([mk("a")], { initiationStages: custom, stageAdds: [] });
    await wait(500);
    const keys1 = JSON.parse(window.eval("JSON.stringify(initiationStages().map(s => s.key))"));
    check("A pre-existing custom list gains the new stage", keys1.indexOf("ctgov") >= 0, keys1);
    check("...positioned before activation, not just appended",
      keys1.indexOf("ctgov") < keys1.indexOf("activation"), keys1);
    check("...and it's recorded as offered", JSON.parse(window.eval("JSON.stringify(state.stageAdds)")).indexOf("ctgov") >= 0);
    window.close();
  }
  {
    // ...but not a second time, once it's been offered and taken back out.
    const trimmed = [{ key: "irb", label: "IRB approval" }, { key: "activation", label: "Site activation / first patient in" }];
    const { window } = boot([mk("a")], { initiationStages: trimmed, stageAdds: ["ctgov", "irb", "activation"] });
    await wait(500);
    const keys2 = JSON.parse(window.eval("JSON.stringify(initiationStages().map(s => s.key))"));
    check("A stage that was offered and removed is NOT re-added", keys2.indexOf("ctgov") < 0, keys2);
    window.close();
  }

  // ------------------------------------------------------------------------- IRB expiry
  console.log("\n-- IRB expiry escalates as the date approaches --");
  {
    const { window } = boot([mk("a")]);
    await wait(500);
    const level = (d) => window.eval(`(function(){ var st = irbExpiryState({ irbExpiry: ${JSON.stringify(d)} }); return st && st.level; })()`);
    check("120 days out is quiet", level(day(120)) === "ok", level(day(120)));
    check("85 days out starts the packet", level(day(85)) === "watch", level(day(85)));
    check("55 days out is coming up", level(day(55)) === "soon", level(day(55)));
    check("20 days out is urgent", level(day(20)) === "urgent", level(day(20)));
    check("Past the date is lapsed", level(day(-3)) === "lapsed", level(day(-3)));
    check("No date recorded means no state at all", window.eval('irbExpiryState({ irbExpiry: "" })') === null);
    check("A lapse says it's reportable",
      /reportable/i.test(window.eval(`irbExpiryState({ irbExpiry: ${JSON.stringify(day(-3))} }).detail`)));
    window.close();
  }

  console.log("\n-- A lapse only shouts on studies it can actually harm --");
  {
    const { window } = boot([mk("a")]);
    await wait(500);
    const matters = (phase) => window.eval(`irbExpiryMatters({ design: "Prospective (Consented)", phase: ${JSON.stringify(phase)} })`);
    check("Enrolling: yes", matters("Enrolling") === true);
    check("Initiation: yes", matters("Initiation") === true);
    check("Data Collection: yes", matters("Data Collection") === true);
    check("Published: no", matters("Published") === false);
    check("On Hold: no", matters("On Hold") === false);
    check("A retrospective chart review isn't in scope here",
      window.eval('irbExpiryMatters({ design: "Retrospective (Non-Consented)", phase: "Enrolling" })') === false);
    window.close();
  }

  console.log("\n-- The study page leads with an imminent or lapsed expiry --");
  {
    const { window } = boot([
      mk("lapsed", { irbExpiry: day(-5) }),
      mk("soon", { irbExpiry: day(20) }),
      mk("fine", { irbExpiry: day(300) }),
      mk("closed", { phase: "Published", irbExpiry: day(-5) })
    ]);
    const doc = window.document;
    await wait(500);
    window.eval('upsertProfile("Adam Yanke"); syncOnline = true;');
    await wait(60);
    const open = async (id) => { window.eval(`tab = "studies"; openStudy("${id}"); render();`); await wait(140); return doc.getElementById("main").innerHTML; };
    const h1 = await open("lapsed");
    check("A lapsed approval is shown on the study page", /IRB LAPSED/.test(h1), (h1.match(/IRB LAPSED[^<]*/) || [])[0]);
    check("...saying how long ago", /5d ago/.test(h1));
    const h2 = await open("soon");
    check("An imminent expiry is shown", /IRB expires in 20d/.test(h2));
    const h3 = await open("fine");
    check("A distant expiry doesn't clutter the page", !/IRB expires in/.test(h3));
    const h4 = await open("closed");
    check("A published study doesn't shout about its expired approval", !/IRB LAPSED/.test(h4));
    window.close();
  }

  console.log("\n-- The Enrolling summary gathers them at the top --");
  {
    const { window } = boot([
      mk("lapsed", { irbExpiry: day(-9) }),
      mk("soon", { irbExpiry: day(45) }),
      mk("fine", { irbExpiry: day(200) }),
      mk("blank", {})
    ]);
    const doc = window.document;
    await wait(500);
    window.eval('upsertProfile("Adam Yanke"); syncOnline = true; tab = "worklist"; worklistLayout = "enrolling"; personFilter = "all"; worklistPerson = "all"; render();');
    await wait(200);
    const h = doc.getElementById("main").innerHTML;
    check("There's a continuing-review panel", /IRB Continuing Review/i.test(h));
    check("The lapsed study is listed", /LAPSED 9d ago/.test(h), (h.match(/LAPSED[^<]*/) || [])[0]);
    check("The one 45 days out is listed", /expires in 45d/.test(h));
    check("The one 200 days out is not", !/expires in 200d/.test(h));
    check("Studies with no expiry recorded are counted, not ignored",
      /no IRB expiry recorded/.test(h), (h.match(/\d+ enrolling stud[^<]*/) || [])[0]);
    check("Enrolment totals still render alongside", /Target \(IRB\)/.test(h));
    window.close();
  }

  console.log("\n-- Nothing is lost on an older record --");
  {
    // A study saved before either field existed.
    const legacy = { id: "old", kind: "study", data: {
      id: "old", title: "Legacy", nickname: "Legacy", pi: "Adam Yanke", team: [],
      design: "Prospective (Consented)", phase: "Enrolling", priority: "Medium", irb: "ORA-old", milestones: []
    }, updated_at: now };
    const { window } = boot([legacy]);
    await wait(500);
    check("Missing NCT becomes an empty string, not undefined", window.eval('studyById("old").nct') === "");
    check("Missing IRB expiry becomes an empty string", window.eval('studyById("old").irbExpiry') === "");
    check("...and produces no warning", window.eval('irbExpiryState(studyById("old"))') === null);
    check("The study itself is untouched otherwise", window.eval('studyById("old").irb') === "ORA-old");
    window.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
