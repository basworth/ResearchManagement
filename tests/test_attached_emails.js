// Emails forwarded as attachments — 5 Nov 2026.
//
// Adam: "I forwarded some emails that were batched together … as attachments for study updates
// like poster and podium acceptances. I never got anything back." Gmail's getAttachments() skips
// attached emails, so the tracker saw only the covering note. The Gmail script now sends the raw
// message when it carries attached emails, and mime.ts pulls each one out.
//
// What these tests hold:
//   1. Every attached email is found — From, Subject, Date and text — including quoted-printable
//      and base64 bodies, HTML-only bodies, and encoded subjects.
//   2. A file inside an attached email (a PDF acceptance letter) comes out byte-for-byte.
//   3. An email attached inside an attached email is found too.
//   4. The server adds them to the text and routes the forward to the reader, which replies.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
let pass = 0, fail = 0;
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);
const dir = PROJECT + "/supabase/functions/ingest-email";
if (!fs.existsSync(dir + "/mime.ts")) { console.log("  skip  supabase/ not in this checkout"); console.log("\nALL CLEAR — 0 passed, 0 failed"); process.exit(0); }

const pdf = Buffer.from("%PDF-1.4\n\x00\xff\xfe binary \x80\x9f end");
const inner2 = [
  "From: Nested <n@example.org>", "Subject: Nested decision", "Content-Type: text/plain; charset=utf-8", "", "Nested body text.",
].join("\r\n");
const email1 = [
  "From: ORS Program <program@ors.org>", "Date: Mon, 3 Nov 2026 10:00:00 -0600",
  "Subject: =?utf-8?Q?ORS_2027_Poster_Acceptance_=E2=80=94_Dixon?=",
  'Content-Type: multipart/mixed; boundary="b1"', "", "--b1",
  "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "",
  "Congratulations, your abstract =E2=80=9CDixon Segmentation=E2=80=9D was accepted as a poster.=", "Second line.",
  "--b1", 'Content-Type: application/pdf; name="letter.pdf"', 'Content-Disposition: attachment; filename="letter.pdf"',
  "Content-Transfer-Encoding: base64", "", pdf.toString("base64"),
  "--b1", "Content-Type: message/rfc822", "", inner2, "--b1--",
].join("\r\n");
const email2 = [
  "From: ORS Program <program@ors.org>", "Subject: ORS 2027 Accepted Paper Presentation",
  "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "",
  Buffer.from("<p>Your abstract <b>Automated Dejour</b> was accepted as a <i>podium</i>.</p>").toString("base64"),
].join("\r\n");
const outer = [
  "From: Adam <a@example.com>", "Subject: FW: ORS 2027 Co-Author Accepted Poster", 'Content-Type: multipart/mixed; boundary="outer"', "",
  "--outer", "Content-Type: text/plain", "", "See attached.",
  "--outer", 'Content-Type: message/rfc822; name="ORS 2027 Co-Author Accepted Poster.eml"', 'Content-Disposition: attachment; filename="a.eml"', "", email1,
  "--outer", "Content-Type: message/rfc822", "", email2, "--outer--", "",
].join("\r\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mime-"));
fs.copyFileSync(dir + "/mime.ts", tmp + "/mime.mts");
fs.writeFileSync(tmp + "/in.txt", outer, "latin1");
fs.writeFileSync(tmp + "/run.mjs", `import { attachedEmails, hasAttachedEmails } from "./mime.mts";
import fs from "fs";
const raw = fs.readFileSync(new URL("./in.txt", import.meta.url), "latin1");
const r = attachedEmails(raw);
console.log(JSON.stringify({ has: hasAttachedEmails(raw), none: hasAttachedEmails("Subject: x\\r\\n\\r\\nhi"), ...r }));`);
let out;
try {
  out = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", tmp + "/run.mjs"], { encoding: "utf8" }));
} catch (e) { check("mime.ts runs", false, String(e.stderr || e.message).slice(0, 400)); process.exit(1); }

console.log("\n-- Attached emails are found --");
check("it knows the forward carries attached emails", out.has === true && out.none === false);
check("all three found (two attached, one nested inside the first)", out.emails.length === 3, out.emails.map(e => e.subject));
const e1 = out.emails.find(e => /Poster/.test(e.subject));
check("an encoded subject is decoded", e1 && e1.subject === "ORS 2027 Poster Acceptance — Dixon", e1 && e1.subject);
check("From and Date come through", e1 && /program@ors\.org/.test(e1.from) && /3 Nov 2026/.test(e1.date));
check("a quoted-printable body is decoded, soft line breaks joined", e1 && /“Dixon Segmentation” was accepted as a poster\.Second line\./.test(e1.text), e1 && e1.text);
const e2 = out.emails.find(e => /Paper/.test(e.subject));
check("an HTML-only, base64 body becomes plain text", e2 && /Automated Dejour was accepted as a podium\./.test(e2.text), e2 && e2.text);
check("an email inside an attached email is found", out.emails.some(e => e.subject === "Nested decision" && /Nested body/.test(e.text)));
console.log("\n-- Files inside attached emails --");
check("the PDF inside comes out", out.files.length === 1 && out.files[0].name === "letter.pdf" && out.files[0].mimeType === "application/pdf");
check("...byte for byte", out.files[0] && Buffer.from(out.files[0].data, "base64").equals(pdf));

console.log("\n-- The server uses them --");
const idx = fs.readFileSync(dir + "/index.ts", "utf8");
check("raw MIME is read only when it carries attached emails", /typeof payload\?\.rawMime === "string" && hasAttachedEmails\(payload\.rawMime\)/.test(idx));
check("each attached email is added to the text as a separate update", /Treat each as a separate update/.test(idx) && /--- Attached email \$\{i \+ 1\} of/.test(idx));
check("files inside join the attachments, same 8-file cap", /const room = Math\.max\(0, 8 - atts\.length\)/.test(idx));
check("a forward with attached emails goes to the reader (which replies)", /atts\.length \|\| nAttachedEmails \|\| looksLikeMeeting/.test(idx));
check("the raw message isn't kept", /delete payload\.rawMime/.test(idx));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
