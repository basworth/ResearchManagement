// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Why this test exists.
//
// The `cancel` action shipped with `acct.id === callerId`, where `callerId` was never declared in
// that file — it's what the SIBLING function calls the same thing. Deleting an invite died with
// "callerId is not defined". The test that was supposed to cover it asserted:
//
//     check("It won't delete the caller's own account", /acct\.id === callerId/.test(fn));
//
// which passed, because the text was there. Grepping source for a string proves the line was
// typed, not that it runs. The edge functions never get exercised by the jsdom suite — they run
// on Deno, in Supabase — so nothing else was going to catch it either.
//
// This compiles all four functions with TypeScript and fails on any undefined name. Remote
// imports (esm.sh, deno.land) aren't fetched, so only local, in-file mistakes are reported —
// which is precisely the class of bug that got through.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const FN_DIR = PROJECT + "/supabase/functions";
// Walk up from whatever file require.resolve() lands on (it varies by TypeScript version) to the
// package root, then take its bin/tsc. Resolving this wrongly doesn't fail loudly — tsc simply
// never runs, every "this bad code is caught" check sees no error, and the suite looks fine.
const TS_ROOT = require("path").dirname(require.resolve("typescript/package.json"));
const TSC = require("path").join(TS_ROOT, "bin", "tsc");
if (!require("fs").existsSync(TSC)) { console.error("TEST FAILED: tsc not found at " + TSC); process.exit(1); }
// A unique scratch directory per run. A fixed path left behind by a run under a different user
// becomes undeletable, and the whole check then fails for a reason that has nothing to do with
// the code it is meant to be checking.
const WORK = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "edgecheck-"));

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "\n       " + extra : "")); }
}

// Minimal ambient declarations for the Deno runtime the functions are written against.
const DENO_DTS = `
declare namespace Deno {
  const env: { get(key: string): string | undefined };
  function serve(handler: (req: Request) => Response | Promise<Response>): void;
}
`;

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, "deno.d.ts"), DENO_DTS);

const slugs = fs.readdirSync(FN_DIR).filter(d => fs.existsSync(path.join(FN_DIR, d, "index.ts")));
console.log("\n-- Functions found --");
check("Every edge function is present",
  ["admin-requests", "ingest-email", "invite-user", "request-update", "stage-alerts", "task-emails",
   "import-publications"].every(s => slugs.includes(s)),
  slugs.join(", "));

const copies = [];
slugs.forEach(s => {
  const dest = path.join(WORK, s + ".ts");
  fs.copyFileSync(path.join(FN_DIR, s, "index.ts"), dest);
  copies.push(dest);
});

console.log("\n-- Compiling --");
let raw = "";
try {
  execFileSync(process.execPath, [TSC,
    "--noEmit", "--noResolve", "--skipLibCheck",
    "--target", "es2022", "--module", "esnext",
    "--lib", "es2022,dom",
    "--types", "",
    path.join(WORK, "deno.d.ts"), ...copies
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  raw = (e.stdout || "") + (e.stderr || "");
}

const lines = raw.split("\n").filter(Boolean);

// TS2307 is "cannot find module" — expected and irrelevant, since remote imports aren't fetched.
// Everything imported therefore lands as an implicit any, so type mismatches aren't meaningful
// here either. Undefined NAMES are, and that's what we assert on.
//
// Matched on the MESSAGE, not the error code, and that distinction is the whole point. The real
// `callerId` bug came back as TS2552 ("Cannot find name 'callerId'. Did you mean 'caller'?")
// because a similarly-spelled name was in scope; TypeScript only uses TS2304 when it has no
// suggestion to offer. A first version of this test filtered on TS2304 alone and sailed straight
// past the very defect it was written for. There are several such codes (2304, 2552, 2662, 2663,
// 2665...) and they all say "Cannot find name", so match that.
const isUndefinedName = (l) => /error TS\d+: Cannot find name/.test(l);
const undefinedNames = lines.filter(isUndefinedName);
const otherReal = lines.filter(l =>
  /error TS\d+:/.test(l) &&
  !/error TS(2307|2306|7016|2688|1479|2823)\b/.test(l) &&
  !isUndefinedName(l));

check("No undefined names anywhere in the edge functions",
  undefinedNames.length === 0,
  undefinedNames.slice(0, 12).join("\n       "));

// Reported separately rather than folded in, so a genuine type error doesn't get lost among
// module-resolution noise, and so the reason for each exclusion above stays visible.
if (otherReal.length) {
  console.log("\n  note: other diagnostics (not failing this test, imports are unresolved by design):");
  otherReal.slice(0, 8).forEach(l => console.log("        " + l));
}

// A canary: deliberately break one file the same way the real bug was broken, and confirm the
// check actually catches it. A green test that cannot fail is worse than no test.
console.log("\n-- The check can actually detect the original bug --");
{
  const canary = path.join(WORK, "canary.ts");
  // Two shapes on purpose. `caller` is in scope, so `callerId` gets TS2552 with a suggestion —
  // the real bug. `noSuchNameAnywhere` has no near-match, so it gets TS2304. Both must be caught.
  fs.writeFileSync(canary, `
const caller = { user: { id: "x" } };
export function f(acct: { id: string }) {
  if (acct.id === callerId) return "a";
  if (acct.id === noSuchNameAnywhere) return "b";
  return caller.user.id;
}
`);
  let out = "";
  try {
    execFileSync(process.execPath, [TSC, "--noEmit", "--noResolve", "--skipLibCheck",
      "--target", "es2022", "--module", "esnext", "--lib", "es2022,dom", "--types", "", canary],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { out = (e.stdout || "") + (e.stderr || ""); }
  const caught = out.split("\n").filter(isUndefinedName);
  check("A typo with a similar name in scope is caught (TS2552 — the real bug's shape)",
    caught.some(l => /callerId/.test(l)), out.split("\n").filter(l => /error TS/.test(l))[0] || "(none)");
  check("A name with no near-match is caught too (TS2304)",
    caught.some(l => /noSuchNameAnywhere/.test(l)));
  check("...and both would have failed the check above", caught.length >= 2, caught.length);
}

// Stronger than the synthetic canary: take the REAL file, undo the one-line fix, and confirm the
// check reports it. This is the evidence that the original defect would not have shipped.
console.log("\n-- Replaying the original defect on the real file --");
{
  const real = fs.readFileSync(path.join(FN_DIR, "invite-user", "index.ts"), "utf8");
  const broken = real.replace(/\n\s*const callerId = caller\.user\.id;/, "");
  check("The fix line was found and removed for the replay", broken !== real);
  const f = path.join(WORK, "replay.ts");
  fs.writeFileSync(f, broken);
  let out = "";
  try {
    execFileSync(process.execPath, [TSC, "--noEmit", "--noResolve", "--skipLibCheck",
      "--target", "es2022", "--module", "esnext", "--lib", "es2022,dom", "--types", "",
      path.join(WORK, "deno.d.ts"), f], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { out = (e.stdout || "") + (e.stderr || ""); }
  const hits = out.split("\n").filter(l => isUndefinedName(l) && /callerId/.test(l));
  check("Without the fix, the check fails on callerId", hits.length > 0,
    out.split("\n").filter(l => /error TS/.test(l))[0] || "(none)");
  // Counted from the file rather than hardcoded: the function gains uses of callerId as it grows
  // (a third arrived with the workspace lookup), and a fixed number turns this canary red for a
  // reason unrelated to the defect it exists to catch. Count CODE lines only — the comments above
  // the declaration mention callerId too, and the compiler rightly says nothing about those.
  const uses = broken.split("\n")
    .filter(l => /\bcallerId\b/.test(l) && !/^\s*(\/\/|\*)/.test(l)).length;
  check("...at every place it was used", hits.length === uses,
    "flagged " + hits.length + " of " + uses + " uses");
  fs.rmSync(f, { force: true });
}

console.log("\n-- The specific bug that got through --");
{
  const iu = fs.readFileSync(path.join(FN_DIR, "invite-user", "index.ts"), "utf8");
  check("callerId is declared before it's used",
    iu.indexOf("const callerId") > 0 && iu.indexOf("const callerId") < iu.indexOf("acct.id === callerId"));
  check("...derived from the verified token, not the request body",
    /const callerId = caller\.user\.id/.test(iu));
  check("The self-delete guard is still there", /acct\.id === callerId/.test(iu));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
