// "Suggest a change": one button, reachable from every screen, that puts a note in front of Adam.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const ME = "22222222-2222-2222-2222-222222222222";
const now = new Date().toISOString();
const items = [
  { id: ME, kind: "profile", updated_at: now, workspace: "spine-singh",
    data: { id: ME, name: "Kern Singh", email: "kern@example.com", alertEmail: "kern.alerts@example.com",
            position: "Clinician", admin: false, reportsTo: "", linkedTo: "", alertEmailAsked: true, degreesAsked: true } }
];
let client;
const dom = new JSDOM(html, {
  runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true;
    win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => { client = makeMockSupabase({ items, userId: ME, email: "kern@example.com" }); return client; } };
  }
});
const { window } = dom, doc = window.document;
const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);

(async () => {
  await wait(400);
  window.eval("syncOnline = true;");

  console.log("\n-- The button is there, on every screen --");
  const btn = doc.getElementById("feedback-btn");
  check("the button exists", !!btn);
  check("it says what it does", btn && /suggest a change/i.test(btn.textContent));
  window.eval(`tab = "settings"; render();`);
  await wait(60);
  check("still there after changing tab", !!doc.getElementById("feedback-btn"));

  console.log("\n-- Filing one --");
  btn.click();
  await wait(60);
  check("the sheet opens", !!doc.getElementById("fb-body"));
  check("you can say whether it's an idea or a problem", !!doc.getElementById("fb-kind"));

  doc.getElementById("fb-kind").value = "problem";
  doc.getElementById("fb-body").value = "Uploading a PDF does nothing when I click Upload";
  doc.getElementById("sheet-save").click();
  await wait(200);

  const sent = (client.__inserted || []).filter(r => r.table === "feedback");
  check("it was sent", sent.length === 1, sent.length);
  check("...with what they wrote", sent[0] && sent[0].body.includes("Uploading a PDF"));
  check("...marked as a problem", sent[0] && sent[0].kind === "problem");
  check("...attributed to them", sent[0] && sent[0].author_name === "Kern Singh", sent[0] && sent[0].author_name);
  check("...with their alert address, so a reply reaches them",
    sent[0] && sent[0].author_email === "kern.alerts@example.com", sent[0] && sent[0].author_email);
  check("...and which lab it came from", sent[0] && sent[0].workspace === "spine-singh", sent[0] && sent[0].workspace);
  check("...and where they were at the time", sent[0] && typeof sent[0].page === "string" && sent[0].page.length > 0, sent[0] && sent[0].page);
  // closeSheet animates out over ~320ms before removing the element, so "closed" means the
  // sheet has lost its visible state, not that it has already left the DOM.
  const sheet = doc.getElementById("sheet");
  check("the sheet closed", !sheet || !sheet.classList.contains("show"));
  await wait(400);

  console.log("\n-- An empty note isn't sent --");
  doc.getElementById("feedback-btn").click();
  await wait(60);
  doc.getElementById("fb-body").value = "   ";
  doc.getElementById("sheet-save").click();
  await wait(120);
  check("nothing was sent", (client.__inserted || []).filter(r => r.table === "feedback").length === 1);
  check("...and the sheet stays open so the text isn't lost", !!doc.getElementById("fb-body"));

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
