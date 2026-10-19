// Settings: societies nested under subspecialty, and the meeting list collapsed — 19 Oct 2026.
//
// Adam: "the conference field and society subscriptions seems redundant, the society subscriptions
// should live under the conference fields as nested information based on the subspecialty", and
// "the tracked meeting list seems like a lot ... at least make it collapseable".
//
// He's right that they were two controls for one decision. Switching off Spine and then scrolling
// past NASS, SRS and CSRS in a separate alphabetical list is the same thought twice, and it left
// it ambiguous which one was actually in charge.
//
// What's held here:
//   * one section, societies inside the subspecialty they belong to
//   * the subspecialty toggle still wins — its societies are shown as unavailable, and SAID to be,
//     rather than silently having no effect
//   * the meeting list starts closed and says what's inside without being opened
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const USER = "test-user-1";
const now = new Date().toISOString();
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const profile = () => ({
  id: USER, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: { id: USER, email: "a@example.com", name: "Adam Yanke", position: "Clinician",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true,
    tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: true },
});
const meeting = (id, society, deadline, extra) => ({
  id, kind: "meeting", updated_at: now, workspace: "sports-yanke",
  data: Object.assign({ id, key: society + "|" + id, society, name: society + " Annual Meeting",
    type: "abstract", deadline, dates: "", location: "", link: "", aim: "", criteria: "",
    funded: [], studyIds: [], unconfirmed: false, verifiedOn: "2026-10-01T09:00" }, extra || {}),
});
const MEETINGS = [
  meeting("m1", "ICRS", inDays(30)), meeting("m2", "AANA", inDays(45)),
  meeting("m3", "NASS", inDays(60)), meeting("m4", "SRS", inDays(70)),
  meeting("m5", "CSRS", inDays(80)), meeting("m6", "AAOS", inDays(90)),
  meeting("m7", "ISASS", "", { hidden: true }),
];

function boot() {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.supabase = { createClient: () => makeMockSupabase({ items: [profile()].concat(MEETINGS) }) };
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
  const w = boot();
  await wait(700);
  const ev = (c) => w.eval(c);
  const settings = async () => { ev('tab = "settings"; render();'); await wait(250); return w.document; };
  const doc = await settings();

  console.log("\n-- One section, not two --");
  const text = doc.querySelector("#main").textContent;
  check("there's a single subscriptions section", /Deadline Subscriptions/.test(text));
  check("...and the old separate society section is gone", !/Society Subscriptions/.test(text), text.slice(0, 400));
  // Subspecialties with no societies and no deadlines aren't listed — an empty row is noise, and
  // in this fixture only three fields have anything in them. (Each field renders two clickable
  // elements, the chevron and the label, so the node count is twice the field count.)
  const fieldNames = new Set([...doc.querySelectorAll("[data-subs-field]")].map(e => e.dataset.subsField));
  check("the subspecialties with content are listed",
    ["Sports medicine", "Spine", "General orthopaedics"].every(f => fieldNames.has(f)), [...fieldNames]);
  check("...and empty ones aren't", !fieldNames.has("Oncology"), [...fieldNames]);

  console.log("\n-- Societies are inside their subspecialty, not loose --");
  // Closed to start, so Settings isn't a wall of thirty toggles.
  check("they start collapsed", doc.querySelectorAll(".sub-socs").length === 0);
  const spineRow = [...doc.querySelectorAll("[data-subs-field]")].find(e => e.dataset.subsField === "Spine");
  check("Spine is listed", !!spineRow);
  spineRow.click();
  await wait(250);
  const openDoc = w.document;
  const spineSocs = [...openDoc.querySelectorAll(".sub-socs .sub-toggle")].map(c => c.dataset.soc);
  check("opening Spine shows its societies", spineSocs.length > 0, spineSocs);
  check("...NASS, SRS and CSRS among them",
    ["NASS", "SRS", "CSRS"].every(s => spineSocs.includes(s)), spineSocs);
  check("...and no sports societies leaked in",
    !spineSocs.includes("ICRS") && !spineSocs.includes("AANA"), spineSocs);

  console.log("\n-- The subspecialty toggle still wins, and says so --");
  const spineToggle = openDoc.querySelector('.field-toggle[data-field-sub="Spine"]');
  spineToggle.checked = false;
  spineToggle.dispatchEvent(new w.Event("change"));
  await wait(250);
  check("the preference is recorded", ev('fieldSubs()["Spine"]') === false);
  ev('settingsFieldOpen["Spine"] = true');   // explicit: clicking toggles, and it is already open
  await settings();
  await wait(100);
  const disabled = [...w.document.querySelectorAll(".sub-socs .sub-toggle")];
  check("its societies are shown as unavailable", disabled.length > 0 && disabled.every(c => c.disabled),
    disabled.map(c => c.dataset.soc + ":" + c.disabled));
  // Greying a control without saying why is how people conclude the app is broken.
  check("...and it explains why rather than just greying out",
    /whole subspecialty is switched off/i.test(w.document.querySelector("#main").textContent));

  console.log("\n-- A society toggle inside still works --");
  ev('setFieldSub("Spine", true); settingsFieldOpen["Spine"] = true;');
  await settings();
  await wait(100);
  const nass = w.document.querySelector('.sub-toggle[data-soc="NASS"]');
  check("NASS is on by default", nass.checked);
  nass.checked = false;
  nass.dispatchEvent(new w.Event("change"));
  await wait(250);
  check("switching it off is recorded", ev('subs()["NASS"]') === false);
  ev('tab = "dashboard"; render();');
  await wait(200);
  const board = w.document.querySelector("#main").textContent;
  check("NASS leaves the board", !/NASS/.test(board));
  check("...and the other spine deadlines stay", /SRS/.test(board), board.slice(0, 200));

  console.log("\n-- The meeting list is collapsed, and says what's in it --");
  const d4 = await settings();
  check("it starts closed", !d4.querySelector("#tracked-meeting-list"));
  const header = [...d4.querySelectorAll("[data-toggle-meetings]")][0];
  check("there's a header to open it", !!header);
  check("...carrying the count without being opened", /7/.test(header.textContent), header.textContent);
  check("...and flagging what needs attention", /hidden/.test(header.textContent) && /undated/.test(header.textContent),
    header.textContent);
  header.click();
  await wait(250);
  check("opening it shows the meetings", w.document.querySelectorAll("#tracked-meeting-list .meeting-row").length === 7);
  check("...with a search box, since it's a long list", !!w.document.getElementById("meeting-search"));

  console.log("\n-- Searching it --");
  const box = w.document.getElementById("meeting-search");
  box.value = "spine";          // nothing matches "spine" by name; societies are what people type
  box.dispatchEvent(new w.Event("input"));
  await wait(150);
  const visible = () => [...w.document.querySelectorAll("#tracked-meeting-list .meeting-row")]
    .filter(r => r.style.display !== "none").length;
  check("a search with no matches hides everything", visible() === 0, visible());
  check("...and says so rather than showing a blank list",
    w.document.getElementById("meeting-search-empty").style.display !== "none");
  box.value = "nass";
  box.dispatchEvent(new w.Event("input"));
  await wait(150);
  check("searching a society finds it", visible() === 1, visible());

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
