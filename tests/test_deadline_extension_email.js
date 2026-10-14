// Societies announce abstract-deadline extensions by email and leave their website showing the
// old date. This reads the email — the better source — and moves the shared deadline.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const block = html.slice(html.indexOf("// Bumped whenever these rules learn something new."),
                        html.indexOf("// ---------- The queue ----------"));
const STUDIES = [{ id: "s1", title: "Saddle OCA of the patella", nickname: "Saddle", irb: "22-0101",
  journal: "", decision: "", abstracts: [], noteEntries: [] }];
const MEETINGS = [
  { id: "m-icrs", key: "ICRS|19th World Congress", society: "ICRS", name: "19th World Congress", deadline: "2026-10-15" },
  { id: "m-aana", key: "AANA|2027 Annual Meeting", society: "AANA", name: "2027 Annual Meeting", deadline: "2026-08-23" },
  { id: "m-ors",  key: "ORS|2027 Annual Meeting",  society: "ORS",  name: "ORS 2027 Annual Meeting", deadline: "2026-08-31" }
];
const run = new Function("state", "console",
  block + "\nreturn { readEmail, readDeadlineExtension, matchMeetingFromText, setMeetings };")(
  { studies: STUDIES }, console);
run.setMeetings(MEETINGS);

let pass = 0, fail = 0;
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);
const read = (subject, body) => run.readEmail("Subject: " + subject + "\n\n" + body, subject);

console.log("\n-- The real one --");
{
  const r = read("ICRS 2027 — Abstract Deadline Extended",
    "Dear Colleagues,\n\nDue to many requests, the abstract submission deadline for the ICRS 2027 World Congress has been extended to October 22, 2026 (midnight CEST).\n\nWe look forward to your submissions.");
  check("it spots the extension", !!r.extension, r.extension);
  check("...on the right meeting", r.extension && r.extension.meetingId === "m-icrs", r.extension);
  check("...with the new date", r.extension && r.extension.to === "2026-10-22", r.extension);
  check("...and knows it moves later", r.extension && r.extension.later === true);
  check("...carrying the old date for the record", r.extension && r.extension.from === "2026-10-15");
}

console.log("\n-- Dates the other way round --");
{
  const r = read("ORS deadline change", "The ORS 2027 Annual Meeting abstract deadline has been moved to 2026-08-10.");
  check("an EARLIER date is still read", !!r.extension, r.extension);
  check("...but flagged as not-later, so it can't auto-apply", r.extension && r.extension.later === false, r.extension);
}

console.log("\n-- Mail that isn't an extension --");
check("an ordinary call for abstracts is not an extension",
  !read("AANA call for abstracts is open", "Abstract submission for the AANA 2027 Annual Meeting is now open. The deadline is August 23, 2026.").extension);
check("a journal decision is not an extension",
  !read("Decision on AJSM-2026-0123", "Your manuscript on the saddle-shaped osteochondral allograft has been accepted.").extension);
check("an extension with no date attached is ignored",
  !read("Deadline extended", "The abstract deadline for ICRS has been extended. Watch this space.").extension);

console.log("\n-- Which meeting it is must be unambiguous --");
check("a society nobody can identify matches nothing",
  !read("Deadline extended", "The abstract deadline has been extended to November 3, 2026.").extension);
check("an acronym on its own is enough", !!run.matchMeetingFromText("the ICRS abstract portal"));
check("a passing mention of a common word is not",
  !run.matchMeetingFromText("our annual meeting submission deadline"));

console.log("\n-- It doesn't disturb the rest of the reader --");
{
  const r = read("ICRS 2027 — Abstract Deadline Extended",
    "The abstract submission deadline for the ICRS 2027 World Congress has been extended to October 22, 2026.");
  check("no note is invented for the study", !r.changes.some(c => c.field === "addNote"), r.changes);
  check("...and no study is wrongly matched", !r.study, r.study && r.study.title);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
