// Taught hints that swallowed every email — 6 Nov 2026.
//
// TJ (via Adam): "Website keeps filing emails under this study, not sure why." Three hints taught
// on 30 Oct had learned the wrong things: the forwarder's own address, scrambled link tokens, and
// "confidentiality", "confidential", "distribution" from the Rush email footer. From then on nearly
// every forward was filed as a note on "Does Normalization Actually Improve…" — including a
// "Published" notice that named its own study word for word.
//
// What these tests hold:
//   1. The real bad hint no longer matches a footer-only email.
//   2. An email naming a study's full title goes to that study even if a word hint disagrees.
//   3. Our own addresses (rushortho.com, rush.edu, studypipeline.com) are never sender hints, old or new.
//   4. Teaching learns real words — not footer words, mailbox words or link junk.
//   5. A hint marked disabled is ignored.
const PROJECT = require("path").join(__dirname, "..");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { makeMockSupabase } = require(__dirname + "/supabase_mock.js");
const html = fs.readFileSync(PROJECT + "/research-tracker.html", "utf8");
const now = new Date().toISOString();
const ME = "11111111-1111-1111-1111-111111111111";
const NORM = "aaaaaaaa-0000-0000-0000-00000000000a", SOFT = "aaaaaaaa-0000-0000-0000-00000000000b", OSTEO = "aaaaaaaa-0000-0000-0000-00000000000c";
let pass = 0, fail = 0;
const check = (n, c, d) => c ? (console.log("  ok  ", n), pass++) : (console.log("  FAIL", n, d === undefined ? "" : "->" + JSON.stringify(d)), fail++);
const study = (id, title) => ({ id, kind: "study", updated_at: now, workspace: "sports-yanke",
  data: { id, title, nickname: "", phase: "Manuscript", pi: "Adam Yanke", team: [], noteEntries: [], milestones: [] } });
const FOOTER = "\n\nThomas (TJ) Turinske and William Lee\nSports Medicine Research Fellows to Adam Yanke, MD, PhD\nMidwest Orthopaedics at RUSH<https://www.rushortho.com/>\n" +
  "1611 W Harrison St.\nChicago, IL 60612\nCONFIDENTIALITY NOTICE: This communication is confidential and intended only for the addressee. Any distribution or copying is prohibited.";
const items = [
  { id: ME, kind: "profile", updated_at: now, workspace: "sports-yanke", data: { id: ME, name: "Adam Yanke", email: "adam.yanke@rushortho.com", position: "Clinician", admin: true, alertEmailAsked: true, degreesAsked: true, tourSeen: 1, balloonsSeen: 999, fieldsChosen: true } },
  study(NORM, "Does Normalization Actually Improve Patellofemoral Instability Measurements? A Systematic Review (Study 1 of 3)"),
  study(SOFT, "Soft-Body Patellar Suture Anchors Show Greater Displacement but Similar Load to Failure Compared With Hard-Body Anchors"),
  study(OSTEO, "Osteonecrosis after Distal Femoral Osteotomy"),
  // The three hints exactly as they were taught on 30 Oct.
  { id: "h-norm", kind: "matchHint", updated_at: now, workspace: "sports-yanke", data: { id: "h-norm", studyId: NORM, sender: "austin.roberts@rushortho.com",
    words: ["confidentiality", "studypipeline", "confidential", "distribution", "studyupdate", "infographic", "communicate"], taughtBy: "William Lee" } },
  { id: "h-osteo", kind: "matchHint", updated_at: now, workspace: "sports-yanke", data: { id: "h-osteo", studyId: OSTEO, sender: "adam.yanke@rushortho.com",
    words: ["ipeiyvtbtml9gdhvbc", "ahr0chm6ly90cmfjay5lzgl0b3jpywxtyw5hz2vy"], taughtBy: "William Lee" } },
  { id: "h-off", kind: "matchHint", updated_at: now, workspace: "sports-yanke", data: { id: "h-off", studyId: OSTEO, sender: "editor@outside-journal.org", words: [], disabled: true } },
];
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/",
  beforeParse(win) {
    win.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    win.confirm = () => true; win.localStorage.setItem("rt-seeded", "1");
    win.supabase = { createClient: () => makeMockSupabase({ items, userId: ME, email: "adam.yanke@rushortho.com" }) };
  } });
const w = dom.window;
const read = (text, subject) => JSON.parse(w.eval(`(function(){ setMatchHints(state.matchHints); var r = readEmail(${JSON.stringify(text)}, ${JSON.stringify(subject || "")}); return JSON.stringify({ id: r.study ? r.study.id : "", basis: r.basis }); })()`));
(async () => {
  await new Promise(r => setTimeout(r, 700));
  console.log("\n-- The emails that went wrong --");
  const pub = read("From: adam.yanke@rushortho.com\n\nPublished: Your article is now published online!" + FOOTER +
    "\n\nDear Adam Yanke,\n\nYour article Soft-Body Patellar Suture Anchors Show Greater Displacement but Similar Load to Failure Compared With Hard-Body Anchors in Arthroscopy has the following publication status: Published Online",
    "Fw: Published: Your article is now published online!");
  check("a notice that names its study's title goes to that study", pub.id === SOFT, pub);
  const quick = read("From: adam.yanke@rushortho.com\n\nQuick check — which of these studies will you be an author on?\nTJ Studies to be on: 1, 2, 3" + FOOTER, "Re: Quick check");
  check("a footer-only email no longer goes to the Normalization study", quick.id !== NORM, quick);
  check("...nor to Osteonecrosis via Adam's own address", quick.id !== OSTEO, quick);
  const ors = read("From: cartilage.restoration@rushortho.com\n\nORS 2027 poster acceptance information." + FOOTER, "FW: ORS 2027 Poster Acceptance Information");
  check("an ORS notice with the footer isn't filed under Normalization", ors.id !== NORM, ors);

  console.log("\n-- Hints are still useful --");
  w.eval(`state.matchHints.push({ id: "h-good", studyId: ${JSON.stringify(NORM)}, sender: "", words: ["trochlear", "dysplasia"] })`);
  check("a hint made of real topic words still works", read("New trochlear dysplasia measurements attached." + FOOTER, "").id === NORM);
  check("a disabled hint is ignored", read("From: editor@outside-journal.org\n\nYour manuscript.", "").id !== OSTEO);

  console.log("\n-- What teaching learns now --");
  check("footer, mailbox and link-junk words aren't kept",
    w.eval(`JSON.stringify(hintPhrasesFrom(${JSON.stringify("Notes on the trochlear dysplasia grading <https://urldefense.com/v3/__https:/track.editorialmanager.com/ahr0chm6ly90cmfjay5lzgl0b3jpywxtyw5hz2vy__>" + FOOTER)}))`),
    );
  const learned = JSON.parse(w.eval(`JSON.stringify(hintPhrasesFrom(${JSON.stringify("Notes on the trochlear dysplasia grading <https://urldefense.com/v3/__https:/track.editorialmanager.com/ahr0chm6ly90cmfjay5lzgl0b3jpywxtyw5hz2vy__>" + FOOTER)}))`));
  check("...only the real ones", learned.includes("trochlear") && !learned.some(x => /confiden|distribution|rushortho|ahr0|editorialmanager|harrison/.test(x)), learned);
  check("our own addresses are never sender hints", !w.eval(`hintSenderOk("adam.yanke@rushortho.com")`) && !w.eval(`hintSenderOk("adam_yanke@rush.edu")`) && !w.eval(`hintSenderOk("studyupdates@studypipeline.com")`) && w.eval(`hintSenderOk("eo@arthroscopyjournal.org")`));
  console.log(`\n${fail ? "FAILED" : "ALL CLEAR"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
