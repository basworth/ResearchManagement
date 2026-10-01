// Shared matching rules — a LITERAL COPY of the block in research-tracker.html that sits between
// "Bumped whenever these rules learn something new" and "The queue".
//
// It is duplicated because the app must read a pasted email with no network, and the server must
// read a forwarded one with no browser. Two copies of a rule is how rules quietly drift apart, so
// test_parser_parity.js runs the same fixtures through both and fails if they ever disagree. If
// you change one, copy it to the other and let the test confirm it.
//
// The only difference between the two: the app reads `state.studies`; here the studies are handed
// in as STUDIES.

// deno-lint-ignore-file no-explicit-any
let STUDIES: any[] = [];
export function setStudies(list: any[]) { STUDIES = list || []; }

// Bumped whenever these rules learn something new. A suggestion records the version that read it,
// so improving the parser re-reads everything it looked at before and got nothing from — otherwise
// a message read by an older, dumber version stays permanently misjudged, which is exactly what
// happened to the first Arthroscopy confirmation.
export const PARSER_VERSION = 3;

// ---------- Protected health information ----------
// The tracker is deliberately study-level and holds no PHI. A forwarded email might, so it is
// scrubbed BEFORE anything is stored — not before it is displayed, which would leave it in the
// database. Conservative on purpose: it would rather redact a grant number that looks like an MRN
// than store an MRN that looks like a grant number.
const PHI_PATTERNS = [
  { re: /\b\d{3}-\d{2}-\d{4}\b/g,                              as: "[ssn removed]" },
  { re: /\bMRN[:# ]*\d{4,12}\b/gi,                             as: "[mrn removed]" },
  { re: /\b(?:medical record(?: number)?|patient id)[:# ]*\d{4,12}\b/gi, as: "[mrn removed]" },
  // A bare 7–12 digit run. Journal tracking IDs carry letters and hyphens, and IRB numbers are
  // matched before this runs, so what's left at this length is usually an identifier.
  { re: /\b\d{7,12}\b/g,                                       as: "[number removed]" },
  { re: /\b(?:dob|date of birth)[:\s]*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/gi, as: "[dob removed]" },
  { re: /\b\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g,                as: "[phone removed]" }
];
export function stripPHI(text) {
  let out = String(text || "");
  const found = [];
  PHI_PATTERNS.forEach(p => {
    out = out.replace(p.re, () => { found.push(p.as); return p.as; });
  });
  return { text: out, redacted: found.length, kinds: [...new Set(found)] };
}

// ---------- Which study is this about? ----------
// Ordered by how specific the evidence is. A journal tracking ID identifies one study and nothing
// else; a nickname appearing in prose might be a coincidence. Returning HOW it matched matters as
// much as the match: a suggestion you can't audit is one you have to re-check by hand anyway.
export function matchStudyFromText(text) {
  const t = String(text || "");
  const studies = STUDIES;
  const tryField = (field, label, minLen) => {
    for (const s of studies) {
      const v = String(s[field] || "").trim();
      if (!v || v.length < (minLen || 4)) continue;
      // Escaped: IRB numbers and tracking IDs contain characters that are regex syntax.
      const re = new RegExp("(^|[^A-Za-z0-9])" + v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^A-Za-z0-9]|$)", "i");
      if (re.test(t)) return { study: s, basis: `${label} ${v}` };
    }
    return null;
  };
  return tryField("journalTrackingId", "tracking ID", 4)
      || tryField("irb", "IRB number", 4)
      || tryField("nct", "ClinicalTrials.gov number", 6)
      // Title before nickname: a full IRB title appearing in an email is unambiguous, whereas a
      // nickname like "Meniscus" could be any of several studies or just a word in a sentence.
      || tryField("title", "study title", 12)
      || tryField("nickname", "nickname", 6)
      // Last resort, and the one that earns its keep in practice: an exact title match is brittle
      // because titles get edited between submission and decision, and journals reformat them. So
      // fall back to the distinctive WORDS — "STABLE" or "saddle" appears in one study and nowhere
      // else, which is stronger evidence than a title that's one comma different.
      || matchByDistinctiveWords(t)
      || null;
}
// Words too common to identify anything. Deliberately includes the vocabulary every orthopaedic
// title shares — "patients", "outcomes", "study" — because a match on those is no match at all.
const MATCH_STOPWORDS = new Set(("a an and are as at be by for from has have in into is it its of on or that the to with " +
  "study studies trial patients patient outcome outcomes clinical results analysis comparison versus vs " +
  "using based effect effects evaluation assessment review prospective retrospective randomized randomised " +
  "treatment surgical surgery repair reconstruction following after before during between among").split(/\s+/));
function matchTokens(str) {
  return [...new Set(String(str || "").toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => w.length >= 4 && !MATCH_STOPWORDS.has(w)))];
}
// Scores every study by the distinctive words it shares with the text, and returns a winner only if
// there is a clear one. Two rules do the work:
//
//   rarity — a word in ONE study's title is worth far more than one in thirty. This is what makes
//            "STABLE" decisive and "tibial" nearly worthless.
//   margin — the best study must be well clear of the runner-up. Where two studies are close, the
//            honest answer is "I don't know", because filing a decision against the wrong study is
//            worse than filing it against none.
function matchByDistinctiveWords(text) {
  const studies = STUDIES;
  if (studies.length < 2) return null;
  const haystack = " " + String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
  // How many studies use each word, so rarity can be weighed.
  const docFreq = new Map();
  const perStudy = studies.map(s => {
    const toks = matchTokens((s.title || "") + " " + (s.nickname || ""));
    toks.forEach(w => docFreq.set(w, (docFreq.get(w) || 0) + 1));
    return { study: s, toks };
  });
  let best = null, second = 0;
  perStudy.forEach(({ study, toks }) => {
    let score = 0;
    const hits = [];
    toks.forEach(w => {
      if (haystack.indexOf(" " + w + " ") < 0) return;
      // Unique to one study: 3 points. Shared by a handful: proportionally less. Longer words are
      // worth slightly more, since a long word matching by chance is less likely.
      const rarity = 3 / (docFreq.get(w) || 1);
      score += rarity * (w.length >= 8 ? 1.4 : 1);
      hits.push(w);
    });
    if (!best || score > best.score) { second = best ? best.score : second; best = { study, score, hits }; }
    else if (score > second) second = score;
  });
  if (!best || best.score < 4) return null;            // too little evidence to name a study
  if (second > 0 && best.score < second * 1.6) return null;  // too close to call
  // The words themselves go in the basis, so a wrong match is obvious rather than mysterious.
  const shown = best.hits.slice().sort((a, b) => (docFreq.get(a) - docFreq.get(b)) || b.length - a.length).slice(0, 4);
  return { study: best.study, basis: `wording — "${shown.join('", "')}"` };
}

// ---------- What is this email telling us? ----------
const DECISION_PATTERNS = [
  { re: /\b(?:major revision|revise and resubmit|major revisions? (?:are )?required)\b/i, decision: "Major revision" },
  { re: /\b(?:minor revision|minor revisions? (?:are )?required)\b/i,                     decision: "Minor revision" },
  { re: /\b(?:we are pleased to (?:accept|inform)|has been accepted|accepted for publication)\b/i, decision: "Accepted" },
  { re: /\b(?:we regret|unable to accept|has been rejected|decline(?:d)? (?:to publish|your))\b/i,  decision: "Rejected" }
];
// A date in any of the shapes these emails actually use, returned as YYYY-MM-DD.
function parseLooseDate(str) {
  const s = String(str || "").trim();
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  m = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b/.exec(s);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
    return `${m[3]}-${String(MONTHS[m[2].slice(0, 3).toLowerCase()]).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
  }
  m = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(s);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
    return `${m[3]}-${String(MONTHS[m[1].slice(0, 3).toLowerCase()]).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`;
  }
  // US order assumed for the ambiguous numeric form — these are American journals and an American
  // IRB. Flagged as a guess so it never auto-applies.
  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(s);
  if (m) return `${m[3]}-${String(+m[1]).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`;
  return "";
}
// ---------- Turning a forwarded email into a note ----------
// Most study email isn't a journal decision. It's a coordinator's update, a quote, a scheduling
// note — information worth keeping that fits no field. Those used to produce nothing but a queue
// entry, and somebody retyped the useful sentence as a note by hand, which is the retyping this
// was supposed to end.
//
// So a matched email becomes a note. The hard part isn't the note, it's the trimming: forwarded
// mail carries a security banner, a signature, a confidentiality footer and the whole quoted
// thread, and a note made of that is worse than no note.
const NOISE_LINE = [
  /^\s*(MOR|Rush) Email Security/i,
  /^\s*This email (originated|alert was generated)/i,
  /^\s*(External Email|EXTERNAL SENDER)/i,
  /\bdo not click links or attachments\b/i,
  /\bwill never ask for user ID\b/i,
  /^\s*(Sent from my|Get Outlook for)/i,
  /^\s*(CONFIDENTIALITY|This (e-?mail|message) (and any|is intended))/i,
  /^\s*(From|To|Cc|Bcc|Date|Sent|Subject|Reply-To):/i,
  /^\s*[-_=]{3,}\s*$/,
  /^\s*>/                                      // the quoted thread underneath a reply
];
// A signature starts here and everything after it is noise.
const SIG_START = /^\s*(--\s*$|Thanks[,!]?\s*$|Thank you[,!]?\s*$|Best[,.]?\s*$|Best regards|Kind regards|Regards[,.]?\s*$|Sincerely)/i;
function cleanForwardedBody(raw) {
  const out = [];
  for (const line of String(raw || "").replace(/\r/g, "").split("\n")) {
    if (SIG_START.test(line)) break;
    if (NOISE_LINE.some(re => re.test(line))) continue;
    out.push(line);
  }
  // Collapse the blank runs left behind by all that removal.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
// The note itself: the subject as a headline, then as much of the trimmed body as is useful.
// Capped, because a note nobody can read at a glance defeats the point of notes.
const NOTE_MAX = 700;
function noteFromEmail(subject, body) {
  const clean = cleanForwardedBody(body);
  if (!clean) return "";
  const head = String(subject || "").replace(/^\s*(FW|FWD|RE):\s*/i, "").trim();
  let text = clean.length > NOTE_MAX ? clean.slice(0, NOTE_MAX).replace(/\s+\S*$/, "") + "…" : clean;
  return (head ? head + "\n" : "") + text;
}

// A proposed change. `safe` decides whether it can apply itself: true only for additions that
// destroy nothing. Anything replacing an existing value is never safe, whatever the field.
function proposal(field, label, to, safe, why) {
  return { field, label, to, safe: !!safe, why: why || "" };
}
// A journal's "we have received your submission" note. Worth reading because it marks the start of
// a round, and because it's the one email that arrives when a paper moves to a NEW journal after a
// rejection — the moment the tracker is most likely to be out of date.
const SUBMISSION_PATTERNS = [
  /your submission[^.]{0,400}?has been received by\s+([A-Z][^.\n]{3,70})/i,
  /has been (?:successfully )?(?:received|submitted) (?:by|to)\s+([A-Z][^.\n]{3,70})/i
];
function readSubmissionConfirmation(body) {
  if (!/submission confirmation|has been received|successfully submitted/i.test(body)) return null;
  for (const re of SUBMISSION_PATTERNS) {
    const m = re.exec(body);
    if (m) {
      // Journals append their own subtitle — "Arthroscopy: The Journal of Arthroscopic and Related
      // Surgery" — and the short name is what anyone would type, so cut at the colon.
      const journal = m[1].split(/[:,]/)[0].replace(/\s+/g, " ").trim();
      if (journal.length >= 3) return { journal };
    }
  }
  return { journal: "" };
}
// The date the email itself was sent, used as the submission date. Read from the forwarded header
// block rather than from anywhere in the body, so a date mentioned in passing can't be mistaken
// for the day it was submitted.
function emailSentDate(body) {
  const m = /^\s*(?:Date|Sent):\s*(.+)$/im.exec(String(body || ""));
  return m ? parseLooseDate(m[1]) : "";
}
export function readEmail(text, subject) {
  const body = String(subject || "") + "\n" + String(text || "");
  const hit = matchStudyFromText(body);
  const changes = [];
  if (hit) {
    const s = hit.study;

    // A submission confirmation, read before decisions: "has been received by Arthroscopy" is not
    // a decision, and reading it as one would be a serious mistake.
    const sub = readSubmissionConfirmation(body);
    if (sub) {
      const when = emailSentDate(body);
      const already = (s.journal || "").trim();
      const movedJournal = sub.journal && already && already.toLowerCase() !== sub.journal.toLowerCase();
      if (movedJournal) {
        // The paper has gone somewhere new. Filing the old round away and starting a fresh one is
        // exactly what the "File this away & submit elsewhere" button does by hand, so propose the
        // whole move as ONE decision rather than three fields that only make sense together.
        changes.push(proposal("newSubmission", `Submitted to ${sub.journal}`,
          sub.journal + (when ? " on " + when : ""), false,
          `the study says ${already}${s.decision ? " (" + s.decision + ")" : ""} — this files that round into Previous Submissions and starts a new one`));
      } else {
        if (sub.journal && !already) changes.push(proposal("journal", "Journal", sub.journal, true, "named in the confirmation"));
        if (when && !s.submittedDate) changes.push(proposal("submittedDate", "Submitted on", when, true, "the date the confirmation was sent"));
        else if (when && s.submittedDate !== when) changes.push(proposal("submittedDate", "Submitted on", when, false, `the email says ${when}, the study says ${s.submittedDate}`));
        // A confirmation means it's with the journal now, so "awaiting decision" is the truth —
        // but only when the study isn't already recording an outcome we'd be erasing.
        if (!s.decision) changes.push(proposal("decision", "Journal decision", "Awaiting decision", true, "it's just been submitted"));
      }
    }

    // Always offered when an email matches, whatever else is in it: the text is the point.
    const note = noteFromEmail(subject, text);
    if (note) changes.push(proposal("addNote", "Note on the study", note, true, "the email, trimmed of signatures and quoted replies"));

    const dec = DECISION_PATTERNS.find(p => p.re.test(body));
    if (dec && s.decision !== dec.decision) {
      // Never safe. A decision drives which fields the manuscript section even shows, and a parser
      // that reads "we regret we cannot offer minor revisions" backwards would be expensive.
      changes.push(proposal("decision", "Journal decision", dec.decision, false,
        "the email reads like a " + dec.decision.toLowerCase()));
    }
    const dueM = /\b(?:revisions?|revised manuscript|response)[^.\n]{0,40}?\b(?:due|by|no later than|within)\b[^.\n]{0,30}?([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/i.exec(body);
    if (dueM) {
      const d = parseLooseDate(dueM[1]);
      // Safe only into an empty field: filling a blank adds information, overwriting a date
      // somebody typed destroys it.
      if (d && !s.revisionsDeadline) changes.push(proposal("revisionsDeadline", "Revisions due", d, true, "stated in the email"));
      else if (d && s.revisionsDeadline !== d) changes.push(proposal("revisionsDeadline", "Revisions due", d, false, "the email says " + d + ", the study says " + s.revisionsDeadline));
    }
    const expM = /\b(?:expir\w+|continuing review|approval period ends?)\b[^.\n]{0,40}?([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/i.exec(body);
    if (expM) {
      const d = parseLooseDate(expM[1]);
      if (d && !s.irbExpiry) changes.push(proposal("irbExpiry", "IRB expiry", d, true, "stated in the email"));
      else if (d && s.irbExpiry !== d) changes.push(proposal("irbExpiry", "IRB expiry", d, false, "the email says " + d + ", the study says " + s.irbExpiry));
    }
  }
  return { study: hit ? hit.study : null, basis: hit ? hit.basis : "", changes };
}

// ---------- Meeting transcripts ----------
// A transcript is a different shape of problem from an email. An email is one message about one
// study; a weekly research meeting walks through a dozen, so the job is to cut the transcript into
// the part that belongs to each study and read each part on its own.
//
// It is also far less reliable evidence. A journal writes "we require major revision"; a person
// says "yeah I think they want revisions, or was that the other one". So NOTHING from a transcript
// applies itself, even changes that would be safe from an email — every proposal waits for a human
// who was in the room. See TRANSCRIPT_NEVER_AUTO_APPLIES below.

// Timestamps and speaker labels carry no meaning for us and confuse the date parser — a VTT
// timestamp looks enough like a date to be worth removing before anything else runs.
function cleanTranscript(raw) {
  return String(raw || "")
    .replace(/^WEBVTT.*$/gim, "")
    .replace(/^\d+$/gm, "")                                        // VTT cue numbers
    .replace(/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->.*$/gm, "")         // VTT / SRT time ranges
    .replace(/^\[?\d{1,2}:\d{2}(:\d{2})?\]?\s*/gm, "")             // [00:12] line prefixes
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
const TRANSCRIPT_NEVER_AUTO_APPLIES = true;
// How many lines after a mention still count as being about that study. Three is a guess, but a
// deliberate one: people say the name and then discuss it for a sentence or two, and reaching
// further starts pulling in the next study on the agenda.
const TRANSCRIPT_CONTEXT_LINES = 3;
// Every study the transcript talks about, with just the lines that talk about it.
//
// Deliberately only matches identifiers and names — it does not try to work out which study an
// unattributed "it" refers to. A segment we can't attribute confidently is better dropped than
// guessed, because a change filed against the wrong study is worse than one nobody filed.
function transcriptSegments(text) {
  const lines = String(text || "").split(/\n/);
  const byStudy = new Map();
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const hit = matchStudyFromText(line);
    if (!hit) return;
    // Stop at the next line that names a DIFFERENT study. Without this the window runs on past
    // "next up, the cartilage study" and hands that study's dates to this one — which is the exact
    // failure that makes an automatic update worse than no update.
    const chunkLines = [lines[i]];
    for (let j = i + 1; j <= i + TRANSCRIPT_CONTEXT_LINES && j < lines.length; j++) {
      const next = matchStudyFromText(lines[j]);
      if (next && next.study.id !== hit.study.id) break;
      chunkLines.push(lines[j]);
    }
    const chunk = chunkLines.join("\n");
    const prev = byStudy.get(hit.study.id);
    if (prev) { prev.text += "\n" + chunk; }
    else byStudy.set(hit.study.id, { study: hit.study, basis: hit.basis, text: chunk });
  });
  return [...byStudy.values()];
}
function readTranscript(text) {
  return transcriptSegments(text).map(seg => {
    const read = readEmail(seg.text, "");
    return {
      study: seg.study,
      basis: seg.basis + " (mentioned in the transcript)",
      text: seg.text,
      // Safety stripped off every proposal: spoken words are not a journal's decision letter.
      changes: read.changes.map(c => Object.assign({}, c, {
        safe: TRANSCRIPT_NEVER_AUTO_APPLIES ? false : c.safe,
        why: c.why + " — heard in the meeting, so worth checking"
      }))
    };
  });
}
// One suggestion per study the meeting discussed. Studies it mentioned but said nothing actionable
// about are skipped: a queue item with no proposal in it is just something else to dismiss.
function ingestTranscript(raw, label) {
  const cleaned = cleanTranscript(raw);
  const clean = stripPHI(cleaned);
  const segments = readTranscript(clean.text);
  const now = new Date().toISOString();
  const mine = currentUser ? profileFor(currentUser.id) : null;
  const made = [];
  segments.forEach(seg => {
    if (!seg.changes.length) return;
    const g = {
      id: uid(),
      createdAt: now,
      source: "transcript",
      from: "",
      forwardedBy: mine ? mine.id : "",
      forwardedByName: mine ? mine.name : "",
      unverified: false,
      subject: (label || "Meeting transcript") + " — " + (seg.study.nickname || seg.study.title),
      text: seg.text.slice(0, 20000),
      redacted: clean.redacted,
      redactedKinds: clean.kinds,
      studyId: seg.study.id,
      basis: seg.basis,
      changes: seg.changes,
      applied: [],
      status: "pending"
    };
    upsertSuggestion(g);
    made.push(g);
  });
  return { made, mentioned: transcriptSegments(clean.text).length, redacted: clean.redacted };
}

