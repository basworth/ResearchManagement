// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Email kinds the parser must tell apart: grant submissions, grant decisions, letters of intent,
// abstract submissions, abstract decisions, manuscript submissions, manuscript decisions.
const fs = require("fs");
const path = PROJECT + "/research-tracker.html";
const html = fs.readFileSync(path, "utf8");
const block = html.slice(html.indexOf("// Bumped whenever these rules learn something new."),
                         html.indexOf("// ---------- The queue ----------"));
const STUDIES = [{
  id: "s1", title: "Saddle-shaped osteochondral allograft of the patella", nickname: "Saddle",
  irb: "22-0101", journal: "", decision: "", abstracts: [], noteEntries: [], grant: {}
}];
const sandbox = { state: { studies: STUDIES }, console };
const run = new Function("state", "console", block + "\nreturn {readEmail, applyChangeTo, abstractOutcomeFromText, readGrantEmail, conferenceFromText};")(sandbox.state, console);

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log("  ok  ", name); pass++; } catch (e) { console.log("  FAIL", name, "—", e.message); fail++; } }
function eq(a, b, m) { if (String(a) !== String(b)) throw new Error((m || "") + " got " + JSON.stringify(a) + " want " + JSON.stringify(b)); }
const study = () => JSON.parse(JSON.stringify(STUDIES[0]));
function read(subject, body) { return run.readEmail("Subject: " + subject + "\n\n" + body, subject); }
const field = (r, f) => r.changes.find(c => c.field === f);

console.log("\n-- Abstract submissions --");
t("a confirmation records a Submitted abstract, not a note", () => {
  const r = read("AAOS 2027 Abstract Submission Confirmation",
    "Thank you for your submission to the 2027 AAOS Annual Meeting. Your abstract on the saddle-shaped osteochondral allograft has been received.");
  const c = field(r, "abstractSubmission");
  if (!c) throw new Error("no abstractSubmission change");
  eq(c.to, "AAOS 2027|Submitted|");
  if (field(r, "addNote")) throw new Error("should not also add a note");
});
t("an acceptance still reads as a podium", () => {
  const r = read("AAOS 2027 Abstract Decision",
    "We are pleased to inform you that your abstract on the saddle-shaped osteochondral allograft has been accepted for podium presentation at the 2027 AAOS Annual Meeting.");
  eq(field(r, "abstractSubmission").to, "AAOS 2027|Accepted|Podium");
});
t("a rejection reads as rejected", () => {
  const r = read("AAOS 2027 Abstract Decision",
    "Your abstract on the saddle-shaped osteochondral allograft was not accepted for the 2027 AAOS Annual Meeting.");
  eq(field(r, "abstractSubmission").to, "AAOS 2027|Rejected|");
});
t("submitted then accepted updates the same meeting entry", () => {
  const s = study();
  run.applyChangeTo(s, { field: "abstractSubmission", label: "x", to: "AAOS 2027|Submitted|" }, { uid: () => "u1", today: () => "2026-10-01" });
  run.applyChangeTo(s, { field: "abstractSubmission", label: "x", to: "AAOS 2027|Accepted|Podium" }, { uid: () => "u2", today: () => "2026-10-02" });
  eq(s.abstracts.length, 1, "one entry only:");
  eq(s.abstracts[0].status, "Accepted");
  eq(s.abstracts[0].format, "Podium");
});

console.log("\n-- Grants --");
t("an award records source, amount and date", () => {
  const r = read("OREF Grant Award Notification",
    "Date: Mon, 28 Sep 2026 09:00:00 -0500\n\nWe are pleased to award funding of $75,000 to your project on the saddle-shaped osteochondral allograft of the patella. This OREF grant begins immediately.");
  eq(field(r, "grantAmount").to, "$75,000");
  eq(field(r, "grantSource").to, "OREF");
  if (!field(r, "grantAwardDate")) throw new Error("no award date");
});
t("an award lands on the nested grant object and enables it", () => {
  const s = study();
  run.applyChangeTo(s, { field: "grantAmount", label: "Amount", to: "$75,000" }, { uid: () => "u", today: () => "2026-10-01" });
  eq(s.grant.amount, "$75,000");
  eq(s.grant.enabled, true);
});
t("it will not overwrite an amount already recorded", () => {
  STUDIES[0].grant = { enabled: true, amount: "$50,000", source: "OREF" };
  const r = read("OREF Grant Award Notification",
    "We are pleased to award funding of $75,000 for the saddle-shaped osteochondral allograft of the patella.");
  eq(field(r, "grantAmount").safe, false, "must wait for a human:");
  STUDIES[0].grant = {};
});
t("a submission confirmation is a note, not an award", () => {
  const r = read("Grant Application Received",
    "Thank you for your submission. Your OREF grant application for the saddle-shaped osteochondral allograft of the patella has been received.");
  if (field(r, "grantAmount")) throw new Error("recorded an award from a submission");
  if (!/application submitted/i.test(field(r, "addNote").to)) throw new Error("note did not say submitted: " + field(r, "addNote").to);
});
t("a letter of intent is recognised as its own stage", () => {
  const r = read("OREF Letter of Intent Received",
    "Your letter of intent for the saddle-shaped osteochondral allograft of the patella has been received and will be reviewed.");
  if (!/letter of intent/i.test(field(r, "addNote").to)) throw new Error("got " + field(r, "addNote").to);
});
t("a decline is recorded without touching the grant fields", () => {
  const r = read("OREF Grant Decision",
    "We regret that your proposal on the saddle-shaped osteochondral allograft of the patella was not selected for funding this cycle.");
  if (field(r, "grantAmount") || field(r, "grantSource")) throw new Error("touched grant fields on a decline");
  if (!/not funded/i.test(field(r, "addNote").to)) throw new Error("got " + field(r, "addNote").to);
});
t("ordinary mail with no grant words is untouched by the grant reader", () => {
  eq(run.readGrantEmail("The saddle paper is ready for review by the team.", study()), null);
});

console.log("\n-- The other kinds still work --");
t("a manuscript decision still reads", () => {
  const r = read("Decision on AJSM-2026-0123",
    "Your manuscript on the saddle-shaped osteochondral allograft of the patella has been accepted for publication in the American Journal of Sports Medicine.");
  if (!field(r, "decision")) throw new Error("no decision change");
});

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
