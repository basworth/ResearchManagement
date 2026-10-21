// Telling the feed what you want more and less of — 20 Oct 2026.
//
// Step four. Two buttons on each expanded item, stored per USER, fed back into the next run as
// explicit instructions rather than as training data.
//
// Why per user and not per lab: two people in one lab read for different reasons, and a PI's
// "never show me this again" must not silence it for their RA. The function pools the votes when
// it runs, and only drops an item when NOBODY wanted it — one person's dislike is a ranking hint,
// not a veto over everyone else.
//
// Why the PMID is the key: the feed is rebuilt every week. A vote keyed on anything else would
// evaporate on the next run, which is the failure that would make the whole feature pointless
// while still appearing to work.
const PROJECT = require("path").join(__dirname, "..");
const TESTDIR = __dirname;
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(TESTDIR + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");

const USER = "test-user-1";
const now = new Date().toISOString();
const profile = (ws) => ({
  id: USER, kind: "profile", updated_at: now, workspace: ws,
  data: { id: USER, email: "k@example.com", name: "Kern Singh", position: "Clinician",
    reportsTo: "", alertEmail: "", alertEmailAsked: true, degreesAsked: true,
    tourSeen: 1, fieldsChosen: true, linkedTo: "", admin: true },
});
const FEED = {
  schema: 1, workspace: "spine-singh", generated: "2026-10-20", reviewed: false, framed: true,
  inDevelopment: [{ id: "NCT0001", kind: "Phase II", meta: "m", title: "A spine trial",
    frame: "f", forWork: "w", short: "s" }],
  newPapers: [{ pmid: "11111111", doi: "10.1/x", verdict: "similar", meta: "m",
    title: "A cervical paper", frame: "f", versus: "", refs: [], forWork: "w", short: "s" },
    { pmid: "22222222", doi: "10.1/y", verdict: "mixed", meta: "m",
    title: "A lumbar paper", frame: "f", versus: "", refs: [], forWork: "w", short: "s" }],
  alsoNoted: [], meetingAbstracts: { items: [], note: "", leadUrl: "" },
};

function boot(ws, extraItems) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/",
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      win.confirm = () => true;
      win.localStorage.setItem("rt-seeded", "1");
      win.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
      win.supabase = { createClient: () => makeMockSupabase({
        items: [profile(ws)].concat(extraItems || []) }) };
    },
  });
  return dom.window;
}

const wait = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  ", name); pass++; }
  else { console.log("  FAIL", name, detail === undefined ? "" : "->" + JSON.stringify(detail)); fail++; }
}

(async () => {
  const w = boot("spine-singh");
  await wait(700);
  const ev = (c) => w.eval(c);

  console.log("\n-- The generated feed comes from the database, not a file --");
  // Keyed on watchFeedRowId, not the config's id — see test_watch_row_ids.js for why sharing one
  // meant the feed was written and then immediately overwritten by the config.
  check("pullAll reads watchFeed", /kind === "watchFeed" && r\.id === watchFeedRowId\(ws\)/.test(html));
  check("...and marks it as this lab's, so the file fetch stands down",
    /watchData = wfRow\.data; watchDataFor = ws;/.test(html));
  check("a realtime feed update lands, for this lab only",
    /if \(!ws \|\| ws === myWorkspace\) \{ watchData = data; watchDataFor = myWorkspace; render\(\); \}/.test(html));

  console.log("\n-- Votes are keyed per person and per lab --");
  const a = ev(`watchVoteRowId("u1", "spine-singh")`);
  const b = ev(`watchVoteRowId("u2", "spine-singh")`);
  const c = ev(`watchVoteRowId("u1", "sports-yanke")`);
  check("two people differ", a !== b);
  check("two labs differ for one person", a !== c);
  check("stable for the same pair", a === ev(`watchVoteRowId("u1", "spine-singh")`));

  console.log("\n-- Voting records, toggles and clears --");
  ev(`myWorkspace = "spine-singh"; watchData = ${JSON.stringify(FEED)}; watchDataFor = "spine-singh";
      state.watchVotes = null; tab = "research"; render();`);
  await wait(150);
  check("no vote to begin with", ev(`watchVoteFor("11111111")`) === "");
  ev(`voteOnWatchItem("11111111", "up")`);
  check("up is recorded", ev(`watchVoteFor("11111111")`) === "up");
  check("...and stored under my id and lab",
    ev(`state.watchVotes.userId`) === USER && ev(`state.watchVotes.workspace`) === "spine-singh");
  ev(`voteOnWatchItem("11111111", "down")`);
  check("switching to down removes the up", ev(`watchVoteFor("11111111")`) === "down"
    && ev(`JSON.stringify(state.watchVotes.up)`) === "[]");
  ev(`voteOnWatchItem("11111111", "down")`);
  check("voting the same way twice clears it", ev(`watchVoteFor("11111111")`) === "");
  check("...leaving both lists empty",
    ev(`JSON.stringify(state.watchVotes.up)`) === "[]" && ev(`JSON.stringify(state.watchVotes.down)`) === "[]");

  console.log("\n-- A vote on one item leaves the others alone --");
  ev(`voteOnWatchItem("11111111", "up"); voteOnWatchItem("NCT0001", "down");`);
  check("the paper kept its up", ev(`watchVoteFor("11111111")`) === "up");
  check("the trial got its down", ev(`watchVoteFor("NCT0001")`) === "down");
  check("an untouched item is still neutral", ev(`watchVoteFor("22222222")`) === "");

  console.log("\n-- The buttons are on the page and don't close the row --");
  ev(`tab = "research"; render();`);
  await wait(150);
  const btns = w.document.querySelectorAll("#main [data-rw-vote]");
  check("buttons rendered", btns.length >= 4, btns.length);
  check("each carries the stable key",
    [...btns].every(b => /^(11111111|22222222|NCT0001)$/.test(b.dataset.rwKey)));
  check("the handler stops the click bubbling to the details toggle",
    /e\.preventDefault\(\); e\.stopPropagation\(\);\s*\n\s*voteOnWatchItem/.test(html));
  check("they sit inside the expanded body, not the summary",
    /rwVoteHTML\(isPaper \? it\.pmid : it\.id\)/.test(html)
    && html.indexOf('rwVoteHTML(isPaper') > html.indexOf('class="rw-body"'));

  console.log("\n-- Somebody else's votes never become mine --");
  check("realtime ignores other people's rows", /data\.userId === currentUser\.id/.test(html));
  const wTwo = boot("spine-singh", [{
    id: "other-row", kind: "watchVote", updated_at: now, workspace: "spine-singh",
    data: { id: "other-row", userId: "somebody-else", workspace: "spine-singh",
            up: ["11111111"], down: [], notes: {} },
  }]);
  await wait(700);
  check("a colleague's votes aren't loaded as mine",
    wTwo.eval(`watchVoteFor("11111111")`) === "", wTwo.eval(`JSON.stringify(state.watchVotes)`));
  wTwo.close();

  console.log("\n-- Signed out, voting is a no-op rather than an error --");
  ev(`currentUser = null;`);
  let threw = null;
  try { ev(`voteOnWatchItem("11111111", "up")`); } catch (e) { threw = String(e); }
  check("no throw", !threw, threw);

  console.log("\n-- What the function does with them --");
  const FN = path.join(PROJECT, "supabase", "functions", "research-watch", "index.ts");
  if (!fs.existsSync(FN)) {
    console.log("  (skipped — supabase/functions isn't in this checkout)");
  } else {
    const fn = fs.readFileSync(FN, "utf8");
    check("votes are pooled across the lab", /from\("items"\)[\s\S]{0,120}"watchVote"/.test(fn));
    check("a split vote is not a veto", /if \(!up\.has\(k\)\) downKeys\.add\(k\)/.test(fn));
    check("...and the reasoning is written down", /one person's dislike is a ranking hint|not a veto/i.test(fn));
    check("ids are turned into titles for the model", /titleFor/.test(fn));
    check("...because a bare PMID means nothing to it", /cannot look a PMID up/.test(fn));
    check("downvoted items are dropped before framing", /prefs\.downKeys\.has\(p\.pmid\)/.test(fn));
    check("preferences outrank the model's taste", /outrank your judgement/.test(fn));
    check("liked and disliked both reach the prompt",
      /THEY ASKED FOR MORE LIKE THESE/.test(fn) && /THEY ASKED FOR LESS LIKE THESE/.test(fn));
    check("this is prompting, not training", /NOT model training|not model training/i.test(html));
  }

  console.log("\n-- Refresh runs only this lab --");
  check("the button sends my workspace", /JSON\.stringify\(\{ workspace: myWorkspace \}\)/.test(html));
  check("it refuses with nothing to search for", /there's nothing to search for yet/.test(html));
  check("it reports what it found, not just success", /paper\$\{r\.papersOut === 1/.test(html));
  check("...and says when summaries are unreviewed", /summaries unreviewed, no model key set/.test(html));

  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
