// Who steers the feed, looking things up live, and keeping what's worth pursuing — 21 Oct 2026.
//
// THREE CHANGES, all from Adam in one afternoon:
//
//   1. "the research recommendation slide that has the API that we can train on more or less
//      studies like this don't show the option to train to the people that work in the lab …
//      This should sit in the lab PI's lap."
//
//      The buttons were on every row for everyone, votes were stored per person and POOLED at the
//      next run. So an RA's thumbs-down was already changing what the PI saw, silently. Lab admin
//      is NOT the gate — Will and TJ are lab admins of sports-yanke and should not hold this — so
//      the config carries a named ownerId plus delegates.
//
//   2. "I would rather have it be a live interactive experience … the API should allow it to
//      change in the moment as opposed to on a schedule."
//
//      A query box that answers now. Open to the whole lab: searching the literature is not a
//      privilege. The line that must not move is that the MODEL NEVER RETRIEVES — the typed words
//      go to PubMed, and the model only explains what comes back. Asking a model for papers
//      produces citations that look perfect and don't exist, which is the one failure mode worse
//      than having no tool at all.
//
//   3. "how do we manage when studies have been reviewed and categorized? The only way to get rid
//      of them is say that we like it or dislike it, I assume?"
//
//      Half right, and worth pinning in a test: the feed is REBUILT every run over a rolling
//      window, so everything ages out by itself; dislike drops an item permanently; like removes
//      nothing. Nothing recorded "we decided to act on this", and an item you wanted vanished with
//      the rest. Keep is that record, and it belongs to the lab rather than to one person.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const PI = "test-user-1";          // the signed-in user in the mock
const RA = "test-user-2";
const now = new Date().toISOString();
const prof = (id, name, admin) => ({
  id, kind: "profile", updated_at: now, workspace: "sports-yanke",
  data: { id, email: name.toLowerCase().replace(/ /g, ".") + "@rushortho.com", name,
    position: admin ? "Clinician" : "Research Assistant", reportsTo: "", alertEmail: "",
    alertEmailAsked: true, degreesAsked: true, tourSeen: 1, fieldsChosen: true, linkedTo: "",
    admin: !!admin },
});
const FEED = {
  schema: 1, workspace: "sports-yanke", generated: "2026-10-21", reviewed: false, framed: true,
  inDevelopment: [{ id: "NCT0001", kind: "Phase II", meta: "m", title: "A knee trial",
    frame: "f", forWork: "w", short: "s" }],
  newPapers: [{ pmid: "11111111", doi: "10.1/x", verdict: "similar", meta: "J Bone Joint Surg",
    title: "A cartilage paper", frame: "f", versus: "", refs: [], forWork: "w", short: "s" }],
  alsoNoted: [], meetingAbstracts: { items: [], note: "", leadUrl: "" },
};
const cfgRow = (extra) => ({
  id: "cfg", kind: "watchConfig", updated_at: now, workspace: "sports-yanke",
  data: Object.assign({ workspace: "sports-yanke", authors: ["Adam Yanke"], keywords: ["cartilage"],
    institution: "Rush", excludeAuthors: [], excludeKeywords: [], societies: [], enabled: true }, extra || {}),
});

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}

const calls = [];
let exploreReply = {
  ok: true, query: "bmac knee", windowDays: 180, framed: true, found: 12,
  papers: [{ pmid: "22222222", title: "BMAC for knee OA", meta: "AJSM", verdict: "mixed",
             short: "s", forWork: "w", versus: "", frame: "f", refs: [] }],
  trials: [],
};

function boot(items) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.fetch = async (url, init) => {
        if (String(url).includes("/functions/v1/research-watch")) {
          calls.push(JSON.parse((init && init.body) || "{}"));
          return { ok: true, status: 200, json: async () => exploreReply };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      };
      win.supabase = { createClient: () => makeMockSupabase({ items }) };
    },
  });
  return dom.window;
}

(async () => {
  // ---- 1. Tuning is the owner's, and nobody else's -------------------------------------------
  console.log("\n-- The PI owns the dial; the lab reads the feed --");
  let w = boot([prof(PI, "Adam Yanke", true), prof(RA, "A Resident", false), cfgRow({ ownerId: PI, tuners: [] })]);
  await new Promise(r => setTimeout(r, 700));
  let ev = (c) => w.eval(c);
  ev(`watchData = ${JSON.stringify(FEED)}; watchDataFor = "sports-yanke"; tab = "research"; render();`);
  await new Promise(r => setTimeout(r, 200));
  check("the owner sees the more/less buttons", ev(`canTuneFeed()`) === true);
  check("...and they are actually on the page",
    w.document.querySelectorAll("#main [data-rw-vote]").length > 0);

  // The same lab, same feed, viewed by somebody who is not the owner.
  ev(`currentUser = { id: ${JSON.stringify(RA)}, email: "a.resident@rushortho.com" }; render();`);
  await new Promise(r => setTimeout(r, 200));
  check("a non-owner does not", ev(`canTuneFeed()`) === false);
  check("...and the buttons are gone, not merely disabled",
    w.document.querySelectorAll("#main [data-rw-vote]").length === 0);
  check("...and the Settings entry for delegating is hidden from them",
    !/Who can steer the feed/.test((() => { ev(`tab = "settings"; render();`); return w.document.getElementById("main").innerHTML; })()));

  console.log("\n-- A delegate named by the PI gets it; a lab admin does not inherit it --");
  check("a named delegate may steer",
    ev(`state.watchConfig = Object.assign({}, state.watchConfig, { tuners: [${JSON.stringify(RA)}] }); canTuneFeed()`) === true);
  check("...and removing them takes it away again",
    ev(`state.watchConfig = Object.assign({}, state.watchConfig, { tuners: [] }); canTuneFeed()`) === false);
  check("being a LAB ADMIN of someone else's lab is not enough",
    ev(`currentUser = { id: "will-id" }; state.profiles = state.profiles.concat([{ id: "will-id", name: "Will", admin: true, workspace: "sports-yanke" }]); canTuneFeed()`) === false);
  check("the comment says why lab admin was rejected as the gate",
    /Will and TJ are lab admins of sports-yanke/.test(html));

  console.log("\n-- The write is guarded too, not just the button --");
  check("voteOnWatchItem refuses a non-owner", /if \(!canTuneFeed\(\)\) \{ toast\("Only the lab's PI/.test(html));
  const before = ev(`JSON.stringify(state.watchVotes)`);
  ev(`voteOnWatchItem("11111111", "up")`);
  check("...and nothing was written", ev(`JSON.stringify(state.watchVotes)`) === before);

  console.log("\n-- An unclaimed feed falls to the lab admin, so a new lab isn't locked out --");
  check("no owner set, admin may steer",
    ev(`currentUser = { id: ${JSON.stringify(PI)} }; state.watchConfig = Object.assign({}, state.watchConfig, { ownerId: "" }); canTuneFeed()`) === true);
  w.close();

  // ---- 2. Looking something up, live ---------------------------------------------------------
  console.log("\n-- Look for something now: open to everyone, answered on the spot --");
  w = boot([prof(PI, "Adam Yanke", true), cfgRow({ ownerId: PI })]);
  await new Promise(r => setTimeout(r, 700));
  ev = (c) => w.eval(c);
  const d = w.document;
  ev(`sb.auth.getSession = async () => ({ data: { session: { user: { id: "${PI}" }, access_token: "t" } } });`);
  ev(`tab = "research"; render();`);
  await new Promise(r => setTimeout(r, 200));
  check("there is a query box", !!d.getElementById("rw-q"));
  check("...and a window selector", !!d.getElementById("rw-window"));
  check("a non-owner can use it too", ev(`currentUser = { id: "someone-else" }; tab = "research"; render(); !!document.getElementById("rw-q")`) === true);
  ev(`currentUser = { id: ${JSON.stringify(PI)} }; render();`);
  await new Promise(r => setTimeout(r, 150));

  d.getElementById("rw-q").value = "bmac knee";
  d.getElementById("rw-go").click();
  await new Promise(r => setTimeout(r, 400));
  const ex = calls.find(c => c.action === "explore");
  check("it calls the function with the typed query", !!ex && ex.query === "bmac knee", calls);
  check("...scoped to this lab", ex && ex.workspace === "sports-yanke");
  check("...with the chosen window", ex && ex.windowDays === 180, ex);
  check("the results render", /BMAC for knee OA/.test(d.getElementById("main").innerHTML));
  check("...and say how many were found", /12 found/.test(d.getElementById("main").innerHTML));

  console.log("\n-- Keep: the answer to 'how do these ever get dealt with' --");
  check("a Keep button is offered", d.querySelectorAll("#main [data-rw-keep]").length > 0);
  ev(`keepResearchItem("22222222")`);
  await new Promise(r => setTimeout(r, 150));
  const kept = JSON.parse(ev(`JSON.stringify(state.watchKeeps)`));
  check("it is kept", kept.length === 1 && kept[0].key === "22222222", kept);
  check("...with the framing that was on screen, not just the id",
    kept[0].title === "BMAC for knee OA" && kept[0].short === "s");
  check("...and who kept it", !!kept[0].keptBy && !!kept[0].keptAt);
  check("the row is the LAB's, not one person's", /one row per lab, not per person/i.test(html)
    || /watchKeepRowId/.test(html));
  check("keeping twice removes it, same as every other toggle here",
    (() => { ev(`keepResearchItem("22222222")`); return JSON.parse(ev(`JSON.stringify(state.watchKeeps)`)).length === 0; })());

  console.log("\n-- Keeping survives the weekly rebuild, which is the whole point --");
  check("kept ideas come from their own row, not from the feed",
    /kind === "watchKeep"/.test(html));
  check("...and realtime keeps the lab in step", /if \(kind === "watchKeep"\)/.test(html));

  console.log("\n-- The explore path on the server --");
  const FN = path.join(PROJECT, "supabase", "functions", "research-watch", "index.ts");
  if (!fs.existsSync(FN)) {
    console.log("  (skipped — supabase/functions isn't in this checkout)");
  } else {
    const fn = fs.readFileSync(FN, "utf8");
    check("there is an explore action", /String\(body\?\.action \|\| ""\) === "explore"/.test(fn));
    check("an empty query is refused", /Type something to look for/.test(fn));
    check("a silly-long query is refused", /That's too long for a search/.test(fn));
    check("RETRIEVAL IS STILL PUBMED'S", /const ids = await pubmedSearch\(term, windowDays/.test(fn));
    check("...and the model only frames what came back",
      /const framed = await frame\(cfg, \[\], papers\.slice\(0, max\), trials/.test(fn));
    check("...with buildFeed's id filter still in the path",
      /const feed = buildFeed\(cfg, \[\], papers\.slice\(0, max\), trials, framed\)/.test(fn));
    check("the reason that line cannot move is written down",
      /citations that look perfect and aren't/.test(fn));
    check("exploring stores nothing", !/explore[\s\S]{0,2000}db\.from\("items"\)\.upsert/.test(fn));
    // Author terms must NOT be quoted. Measured against PubMed, Brian Cole + Rush affiliation:
    //   Cole B[Author]   -> 556      "Cole B"[Author] -> 23
    // phrase() quotes anything with a space, which switched off PubMed's expansion of author
    // initials (Cole B -> Cole BJ). Adam's feed reported own:3 for 258 papers; Cole's reported 6.
    check("author terms are never quoted",
      /out = new Set<string>\(\[`\$\{n\}\[Author\]`\]\)/.test(fn)
      && /out\.add\(`\$\{last\} \$\{initials\}\[Author\]`\)/.test(fn)
      && !/phrase\(last/.test(fn) && !/phrase\(n\)\[Author\]/.test(fn));
    check("...and the measured difference is recorded",
      /556 papers/.test(fn) && /23 papers/.test(fn));
    check("the lab's learned exclusions still apply",
      /const notClause = notKws\.map\(\(k\) => `NOT \$\{phrase\(k\)\}\[Title\/Abstract\]`\)/.test(fn));
    // THE ONE THAT MATTERED MOST. PubMed parses "A AND NOT (B)" by dropping the NOT and keeping
    // the AND, so an exclusion list silently becomes a REQUIREMENT list. Measured, not assumed:
    // "bone marrow aspirate concentrate knee osteoarthritis" over one year returns 40 papers; with
    // "AND NOT (YouTube OR case report)" it returned 2, and the query_translation showed
    // `AND ("YouTube"[All Fields] OR "case report"[All Fields])`. With the binary form, 38.
    // Comments have to quote the broken form to explain it, so this reads CODE lines only.
    const codeOnly = fn.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    check("exclusions use the binary NOT, never AND NOT",
      !/AND NOT/.test(codeOnly) && /\$\{notClause \? " " \+ notClause : ""\}/.test(fn),
      (codeOnly.match(/.{0,40}AND NOT.{0,40}/) || [])[0]);
    check("...and the measurement is recorded, so nobody 'tidies' it back",
      /2 results wrong, 38 right/.test(fn));
    // The first live run returned 2 papers for "bone marrow aspirate concentrate knee
    // osteoarthritis" over a whole year, because the whole string was phrase()-wrapped and PubMed
    // hunted for that exact phrase. A thin result set reads as "the field is quiet", which is the
    // worst possible way for a search box to be wrong.
    check("the typed query is NOT wrapped in quotes",
      /const term = `\(\$\{q\}\)/.test(fn) && !/phrase\(q\)/.test(fn));
    check("...and why both of these bit is written down",
      /IS NOT AN EXCLUSION/.test(fn) && /2 results wrong, 38 right/.test(fn));
    check("...but the institution filter does not, so other groups' work shows up",
      /The institution is NOT applied/.test(fn));

    console.log("\n-- Only the owner's votes are pooled, enforced server-side --");
    check("readPrefs takes the config", /async function readPrefs\(db: any, ws: string, priorFeed: any, cfg: Cfg\)/.test(fn));
    check("...builds the allowed set from owner + tuners",
      /new Set<string>\(\[owner, \.\.\.clean\(\(cfg as any\)\.tuners\)\]\)/.test(fn));
    check("...and skips everyone else's rows",
      /if \(allowed && !allowed\.has\(String\(row\?\.data\?\.userId \|\| ""\)\)\) continue;/.test(fn));
    check("historic votes stopping overnight is called out as intended",
      /must stop counting the moment this ships/.test(fn));
  }

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
