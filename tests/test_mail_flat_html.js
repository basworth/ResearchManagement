// "=20" in tracker emails — 28 Oct 2026.
//
// Adam got an admin-request email with a stray "=20" line. Indented HTML leaves lines ending in a
// space; the Gmail SMTP path quoted-printable-encodes that as "=20" and some clients print it.
// ingest-email had already fixed this once for its receipt; every other sender still had it.
// What this holds: every function that sends through SMTP flattens its HTML to one line first.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const dir = PROJECT + "/supabase/functions";
let pass = 0, fail = 0;
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);
if (!fs.existsSync(dir)) { console.log("  skip  supabase/ not in this checkout\n\n0 passed, 0 failed"); process.exit(0); }
const FLAT = 'replace(/\\s*\\n\\s*/g, " ").replace(/ {2,}/g, " ")';
const senders = fs.readdirSync(dir).filter(f => fs.existsSync(`${dir}/${f}/index.ts`))
  .filter(f => /(smtp|client\(\))\.send\(/.test(fs.readFileSync(`${dir}/${f}/index.ts`, "utf8")));
check("there are SMTP senders to check", senders.length >= 6, senders);
senders.forEach(f => {
  const src = fs.readFileSync(`${dir}/${f}/index.ts`, "utf8");
  check(`${f} flattens its HTML before sending`, src.includes(FLAT));
});
const ar = fs.readFileSync(`${dir}/admin-requests/index.ts`, "utf8");
check("the admin-request email points at where the setting now lives", /Account &amp; user settings &rsaquo; Admin Access/.test(ar));
check("...and approval says 'in your lab', not 'every project'", !/see every project\./.test(ar));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
