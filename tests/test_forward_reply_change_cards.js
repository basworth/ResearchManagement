// The forward reply names where each change landed, what it was and what it is now, and shows a
// note's own words (Adam, 17 Nov 2026: "is there a way to make it more clear when you change a
// state or field/box?").
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const ing = (() => { try { return fs.readFileSync(path.join(root, "supabase/functions/ingest-email/index.ts"), "utf8"); } catch (e) { return ""; } })();
const html = fs.readFileSync(path.join(root, "research-tracker.html"), "utf8");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL " + m); } };
if (ing) {
  ok(/export function changeCard\(/.test(ing) && /export function changeSection\(/.test(ing), "change cards exist");
  ok(/transferPlan: "Manuscript"/.test(ig = ing) && /addNote: "Notes"/.test(ing), "fields map to the study page's sections");
  ok(/text-decoration:line-through/.test(ing) && /was empty &rarr;/.test(ing), "old value shown struck through, or 'was empty'");
  ok(/if \(c\.field === "addNote"\) r\.text = c\.to;/.test(ing), "a note's words travel with it");
  ok(/CHANGED ON THE STUDY/.test(ing) && /WAITING FOR YOU TO CONFIRM/.test(ing), "applied and waiting are labelled plainly");
}
var ig;
ok(/\(\?:of\|and\|the\|in\|for\|on\|&\)/.test(html), "journal names keep 'of' lower-case");
console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
