// Sending from studypipeline.com, the warm-up — 28 Oct 2026.
//
// Adam: tracker mail lands in spam; MOR IT "will never allow anything". The fix that needs nobody's
// permission is mail from our own domain, warmed up on low-stakes mail first. What this holds:
//   1. One helper, copied identically into each sending function (Supabase deploys them apart).
//   2. Task reminders, stalled-study alerts and meeting summaries try the domain first and fall
//      back to Gmail; sign-in codes are not touched (they go through Supabase Auth).
//   3. The key is a secret, never in the code; with no key, nothing changes.
//   4. Meeting summaries stay threaded under the meeting email.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const dir = PROJECT + "/supabase/functions";
let pass = 0, fail = 0;
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);
if (!fs.existsSync(dir + "/task-emails/warmup-mail.ts")) {
  console.log("  skip  supabase/ not in this checkout");
  console.log("\n0 passed, 0 failed"); process.exit(0);
}
const fns = ["task-emails", "stage-alerts", "ingest-email"];
const copies = fns.map(f => fs.readFileSync(`${dir}/${f}/warmup-mail.ts`, "utf8"));
const helper = copies[0];
console.log("\n-- One helper, the same everywhere --");
check("every sending function carries an identical copy", copies.every(c => c === helper));
check("the key comes from a secret", /Deno\.env\.get\("RESEND_API_KEY"\)/.test(helper) && !/re_[A-Za-z0-9]{10,}/.test(copies.join("")));
check("no key means no change", /if \(!RESEND_API_KEY \|\| !RESEND_KINDS\.includes\(m\.kind\)\) return false;/.test(helper));
check("low-stakes kinds only, by default", /"task,stage,meeting"/.test(helper) && !/auth|recovery|invite/.test((helper.match(/RESEND_KINDS = [^;]+;/) || [""])[0]));
check("sends from our own domain", /updates@mail\.studypipeline\.com/.test(helper));
check("a refusal falls back rather than failing", /if \(!r\.ok\)[\s\S]*?return false;/.test(helper) && /catch \(e\)[\s\S]*?return false;/.test(helper));
check("threading headers are passed through", /"In-Reply-To"/.test(helper) && /"References"/.test(helper));

console.log("\n-- Each function tries the domain, then Gmail --");
const src = Object.fromEntries(fns.map(f => [f, fs.readFileSync(`${dir}/${f}/index.ts`, "utf8")]));
fns.forEach(f => check(`${f} imports it`, /import \{ sendViaDomain \} from "\.\/warmup-mail\.ts";/.test(src[f])));
check("task reminders: domain first, then the SMTP client",
  /sendViaDomain\(\{ kind: "task"[\s\S]*?return;\s*const client = await smtpClient\(\);/.test(src["task-emails"]));
check("stalled-study alerts: domain first, then Gmail",
  /sendViaDomain\(\{ kind: "stage"[\s\S]*?return;\s*const msg/.test(src["stage-alerts"]));
const meet = src["ingest-email"];
check("meeting summaries: domain first, still threaded", /sendViaDomain\(\{ kind: "meeting"[\s\S]*?inReplyTo: opts\.inReplyTo, references: opts\.references \}\)\) return true;/.test(meet));
check("...and Gmail after", /return true;\s*if \(!SMTP_USER \|\| !SMTP_PASSWORD\) return false;\s*const smtp = new SMTPClient/.test(meet));
check("the forwarder's receipt too", /sendViaDomain\(\{ kind: "meeting", fromName: FROM_NAME, to, subject: matched/.test(meet));
check("replies still reach the tracker's inbox", (meet.match(/replyTo: SMTP_USER \|\| undefined/g) || []).length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
