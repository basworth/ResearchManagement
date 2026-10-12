#!/usr/bin/env node
// Runs every test file in this folder and prints one summary.
//
// Exists because five tests had been quietly failing for weeks — the suite was only ever run a
// handful of files at a time, by hand, and nobody saw the rest. Exit code is 0 only when
// everything passes, so a scheduled run can stay silent unless something is actually wrong.
//
//   node tests/run-all.js            # everything (~5 minutes)
//   node tests/run-all.js --quick    # skip the slowest files
//   node tests/run-all.js --all      # include the *_debug.js scratch copies
//   node tests/run-all.js 2/4        # just the second quarter — the whole suite outruns a
//                                    # two-minute command limit, so run 1/4 … 4/4 in turn
//
// Needs jsdom and typescript. It will install them into /tmp/node_modules if they're missing.
const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const DIR = __dirname;
const MODS = "/tmp/node_modules";
// Generous, because several files run four-at-a-time and the slowest (full jsdom boots over a
// 550 KB page, repeated per scenario) take well over a minute under that contention.
const TIMEOUT_MS = 150000;

// Two shapes of test live here: ones that count their own assertions and end with "N passed,
// M failed", and older scripts that just print lines and throw on failure. Read both.
function verdict(out, code, timedOut) {
  if (timedOut) return { ok: false, why: "timed out after " + (TIMEOUT_MS / 1000) + "s" };
  const tally = out.match(/(\d+) passed, (\d+) failed/);
  if (tally) {
    const failed = Number(tally[2]);
    return failed ? { ok: false, why: tally[0] } : { ok: true, why: tally[0] };
  }
  if (/TEST FAILED|^\s*FAIL /m.test(out)) return { ok: false, why: "reported a failure" };
  // A printed "something: false" is how the older scripts report a problem.
  const falses = out.split("\n").filter(l => /: false\s*$/.test(l));
  if (falses.length) return { ok: false, why: falses.length + " check(s) printed false" };
  if (code !== 0) return { ok: false, why: "exited with code " + code };
  if (/TEST DONE/.test(out)) return { ok: true, why: "ran clean" };
  return { ok: false, why: "produced no verdict — check it by hand" };
}

function ensureDeps() {
  const need = ["jsdom", "typescript"].filter(m => !fs.existsSync(path.join(MODS, m)));
  if (!need.length) return;
  console.log("Installing " + need.join(", ") + " …");
  execFileSync("npm", ["install", "--silent", "--prefix", "/tmp"].concat(need), { stdio: "inherit" });
}

const SLOW = ["test_suggested_updates.js", "test_invites_linking_alerts.js", "test_assignee_picker.js"];
const quick = process.argv.includes("--quick");
// "2/4" = the second of four equal slices, so a long suite fits inside a short command timeout.
const shardArg = process.argv.slice(2).find(a => /^\d+\/\d+$/.test(a));
const [shardNo, shardCount] = shardArg ? shardArg.split("/").map(Number) : [1, 1];

ensureDeps();
const files = fs.readdirSync(DIR)
  .filter(f => /^test_.*\.js$/.test(f))
  // *_debug.js files are scratch copies of a sibling test, kept for reference. They have no mock
  // database, so they sit waiting on a network that isn't there and time the whole run out.
  // Their non-debug twin covers the same ground. Pass --all to include them anyway.
  .filter(f => !/_debug\.js$/.test(f) || process.argv.includes("--all"))
  .filter(f => !quick || !SLOW.includes(f))
  .sort()
  .filter((f, i) => shardCount === 1 || (i % shardCount) === (shardNo - 1));

// Six tests read the edge-function sources under supabase/functions. Those live in Adam's
// workspace folder but are deliberately NOT published to the public repo, so in CI they have
// nothing to read. Skipping them there is honest — reporting them as failures would train
// everyone to ignore a red run, which is how the last five broken tests went unnoticed.
const needsFunctions = fs.existsSync(path.join(DIR, "..", "supabase", "functions"))
  ? []
  : files.filter(f => /supabase\/functions/.test(fs.readFileSync(path.join(DIR, f), "utf8")));
const toRun = files.filter(f => !needsFunctions.includes(f));

const failures = [];
let passed = 0;
const started = Date.now();

// Each file boots its own jsdom over a 550 KB page, so they are slow and completely independent.
// Running a few at once turns five minutes into a little over one, which is the difference
// between a suite that fits in a scheduled run and one that gets killed halfway.
const CONCURRENCY = Number(process.env.TEST_CONCURRENCY || 4);

function runOne(f) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(DIR, f)], {
      env: Object.assign({}, process.env, { NODE_PATH: MODS })
    });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, TIMEOUT_MS);
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { out += d; });
    child.on("close", code => {
      clearTimeout(timer);
      const v = verdict(out, code, timedOut);
      if (v.ok) { passed++; process.stdout.write("."); }
      else {
        process.stdout.write("x");
        const detail = out.split("\n")
          .filter(l => /FAIL|TEST FAILED|Error|: false\s*$/.test(l))
          .slice(0, 8).join("\n");
        failures.push({ file: f, why: v.why, detail });
      }
      resolve();
    });
  });
}

(async () => {
  const queue = toRun.slice();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) await runOne(queue.shift());
  }));
  report();
})();

function report() {
const secs = Math.round((Date.now() - started) / 1000);
console.log("\n");
if (!failures.length) {
  console.log(`ALL CLEAR — ${passed} test files passed in ${secs}s${shardArg ? " (slice " + shardArg + ")" : ""}.`
    + (needsFunctions.length ? `\n(${needsFunctions.length} skipped — they read supabase/functions, which isn't in this checkout.)` : ""));
  process.exit(0);
}
console.log(`${failures.length} of ${toRun.length} test files FAILED (${secs}s):\n`);
failures.forEach(f => {
  console.log("  " + f.file + " — " + f.why);
  if (f.detail) console.log(f.detail.split("\n").map(l => "      " + l.trim()).join("\n"));
  console.log("");
});
process.exit(1);
}
