// Paths are derived from this file's own location so the suite runs anywhere — the sandbox
// mount name changes between sessions, and hardcoding it is why this suite quietly stopped
// being runnable. PROJECT is the folder holding research-tracker.html; TESTDIR is this folder.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
// Why this test exists.
//
// The profile guard in the database refused every admin's own profile save for nine days, and
// nobody knew, because pushItem() logged the refusal to the console and set the pill to
// "Offline". The app looked like it had saved. Adam only found it because the degrees question
// kept coming back on every refresh — the one visible consequence of an invisible failure.
//
// The database side is fixed and verified separately (see supabase/admin-requests-setup.sql).
// This covers the client side: a refusal must be SHOWN, because it will never succeed on retry,
// while a network blip must stay quiet, because it will.
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");

const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ADAM = "11111111-1111-1111-1111-111111111111";

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

// `upsertError` is what the mock's upsert will report back.
function boot(upsertError) {
  const items = [
    { id: ADAM, kind: "profile", updated_at: now,
      data: { id: ADAM, name: "Adam Yanke", email: "adam.yanke@rushortho.com", position: "Clinician",
              admin: true, reportsTo: "", alertEmail: "", linkedTo: "", alertEmailAsked: true, degreesAsked: true } },
    { id: "00000000-0000-0000-0000-000000000001", kind: "meta", updated_at: now,
      data: { id: "00000000-0000-0000-0000-000000000001", names: ["Adam Yanke"], degrees: {} } }
  ];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, pending: [], active: [] }) });
      win.supabase = { createClient: () => {
        const c = makeMockSupabase({ items });
        const realFrom = c.from.bind(c);
        c.from = (table) => {
          const q = realFrom(table);
          if (table === "items" && upsertError) {
            const orig = q.upsert.bind(q);
            q.upsert = async (row) => {
              // Only profile writes fail, so the test can prove other kinds are unaffected.
              if (row && row.kind === "profile") {
                if (upsertError.thrown) throw upsertError.thrown;
                return { data: null, error: upsertError };
              }
              return orig(row);
            };
          }
          return q;
        };
        c.auth.getSession = async () => ({ data: { session: { access_token: "tok", user: { id: ADAM, email: "adam.yanke@rushortho.com" } } }, error: null });
        return c;
      } };
    }
  });
  return dom;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

async function signedIn(dom) {
  const { window } = dom;
  await wait(600);
  window.eval(`currentUser = { id: ${JSON.stringify(ADAM)}, email: "adam.yanke@rushortho.com" }; syncOnline = true;`);
  window.document.querySelectorAll("#sheet-bd, #sheet").forEach(el => el.remove());
  await wait(60);
}
const toastText = (doc) => doc.getElementById("toast").textContent;
const pillText = (doc) => (doc.getElementById("sync-pill") || { textContent: "" }).textContent;

// The exact shape supabase-js returns for a trigger raising an exception.
const GUARD_REFUSAL = {
  message: "Admin rights are granted by request and approval, not directly",
  code: "P0001", details: null, hint: null
};

(async () => {
  console.log("\n-- Telling the two failures apart --");
  {
    const dom = boot(null); const { window } = dom;
    await signedIn(dom);
    const refusal = (o) => window.eval(`isServerRefusal(${JSON.stringify(o)})`);
    check("A Postgres error is a refusal", refusal(GUARD_REFUSAL) === true);
    check("An RLS denial is a refusal",
      refusal({ message: "new row violates row-level security policy", code: "42501" }) === true);
    check("A dropped connection is not", refusal({ message: "Failed to fetch" }) === false);
    check("Safari's wording is not either", refusal({ message: "Load failed" }) === false);
    check("Our own timeout is not", refusal({ message: "Connecting to Team Sync timed out" }) === false);
    check("A bare error with no detail is treated as network", refusal({ message: "something odd" }) === false);
    check("Nothing at all doesn't throw", refusal(null) === false);
    // A Postgres code attached to a fetch failure must still read as network — the network
    // wording wins, because retrying is the right response and nagging would be wrong.
    check("Ambiguous cases fall to network",
      refusal({ message: "Failed to fetch", code: "P0001" }) === false);
    window.close();
  }

  console.log("\n-- The refusal is explained in plain language --");
  {
    const dom = boot(null); const { window } = dom;
    await signedIn(dom);
    const why = (m) => window.eval(`refusalReason(${JSON.stringify({ message: m, code: "P0001" })})`);
    check("The admin-flag refusal names it as a likely bug",
      /that's a bug, not a rule/i.test(why("Admin rights are granted by request and approval, not directly")),
      why("Admin rights are granted by request and approval, not directly"));
    check("Editing someone else is explained as a rule",
      /only admins can edit someone else/i.test(why("Only an admin can change someone else's profile")));
    check("The last-admin guard says what to do instead",
      /Make someone else an admin first/i.test(why("Cannot remove the last admin — promote someone else first")));
    check("An RLS denial is put in everyday terms",
      /don't have permission/i.test(why("new row violates row-level security policy for table \"items\"")));
    check("An unrecognised refusal still shows the server's own words",
      why("some brand new constraint") === "some brand new constraint");
    window.close();
  }

  console.log("\n-- A refused save is surfaced, not hidden behind 'Offline' --");
  {
    const dom = boot(GUARD_REFUSAL); const { window } = dom, doc = window.document;
    await signedIn(dom);
    window.eval(`upsertProfile("Adam Yanke", { degreesAsked: true });`);
    await wait(400);
    const t = toastText(doc);
    check("The user is told it didn't save", /didn't save/i.test(t), t);
    check("...and why", /blocked a change to admin rights/i.test(t), t);
    check("The pill does NOT claim we're offline", !/offline/i.test(pillText(doc)), pillText(doc));
    window.close();
  }

  console.log("\n-- A refusal thrown rather than returned is handled the same --");
  {
    const err = Object.assign(new Error(GUARD_REFUSAL.message), { code: "P0001" });
    const dom = boot({ thrown: err }); const { window } = dom, doc = window.document;
    await signedIn(dom);
    window.eval(`upsertProfile("Adam Yanke", { degreesAsked: true });`);
    await wait(400);
    check("Still reported", /didn't save/i.test(toastText(doc)), toastText(doc));
    window.close();
  }

  console.log("\n-- A network blip stays quiet and shows Offline --");
  {
    const dom = boot({ thrown: new TypeError("Failed to fetch") });
    const { window } = dom, doc = window.document;
    await signedIn(dom);
    // Clear whatever the boot sequence said, so the assertion is about this save only.
    window.eval(`document.getElementById("toast").textContent = "";`);
    window.eval(`upsertProfile("Adam Yanke", { degreesAsked: true });`);
    await wait(400);
    check("No scary message", !/didn't save/i.test(toastText(doc)), toastText(doc));
    check("The pill says Offline", /offline/i.test(pillText(doc)), pillText(doc));
    window.close();
  }

  console.log("\n-- Only the rejected write is affected --");
  {
    const dom = boot(GUARD_REFUSAL); const { window } = dom;
    await signedIn(dom);
    // A study save goes through the same pushItem and must be untouched by the profile refusal.
    window.eval(`state.studies.push({ id: "s-test", title: "Guard check", phase: "Enrolling", tasks: [] }); pushItem("study", state.studies[state.studies.length-1]);`);
    await wait(300);
    check("A study still saves", window.eval(`!!remoteMeta["s-test"]`), window.eval(`JSON.stringify(remoteMeta["s-test"] || null)`));
    window.close();
  }

  console.log("\n-- The database fix itself --");
  {
    const sql = fs.readFileSync(PROJECT + "/supabase/admin-requests-setup.sql", "utf8");
    check("had_admin is no longer hardcoded false on the insert path",
      !/had_admin\s+boolean\s*:=\s*case when tg_op = 'UPDATE'[\s\S]{0,120}else false end/.test(sql));
    check("...it reads the stored row instead", /into had_admin[\s\S]{0,120}from items i where i\.id = new\.id/.test(sql));
    check("A genuinely new row still counts as never having been admin",
      /had_admin := coalesce\(had_admin, false\)/.test(sql));
    check("An omitted admin key is carried forward, not treated as false",
      /not \(new\.data \? 'admin'\)[\s\S]{0,160}jsonb_set/.test(sql));
    check("The no-op shortcut also handles the upsert path",
      /elsif exists \(select 1 from items i where i\.id = new\.id[\s\S]{0,80}i\.data = new\.data\)/.test(sql));
    check("The refusals it exists to enforce are still there",
      /Only an admin can change someone else/.test(sql) &&
      /Admin rights are granted by request and approval/.test(sql) &&
      /Cannot remove the last admin/.test(sql));
    check("Why it broke is written down for next time", /ON CONFLICT DO UPDATE/.test(sql));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error("TEST FAILED:", e); process.exit(1); });
