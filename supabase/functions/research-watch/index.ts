// Builds each lab's research feed from its own watchConfig.   20 Oct 2026
//
// Replaces the hand-assembled watch-<lab>.json files. Runs on a schedule (pg_cron) or on demand
// from the app's "Refresh now" button.
//
// THE SPLIT THAT MATTERS: retrieval is deterministic, framing is not.
//
//   PubMed and ClinicalTrials.gov decide what EXISTS. Plain HTTP queries built from the lab's
//   config, no model involved. A model cannot invent a PMID here because it is never asked what
//   exists — only what a thing means.
//
//   The model then writes the "how this relates to your work" line and orders the list. If it is
//   wrong you get a poor explanation attached to a real paper, which somebody notices and can
//   correct. The alternative — letting a model produce the citations — fails silently and
//   plausibly, which in a research tool is the one failure mode worth designing out entirely.
//
// Without ANTHROPIC_API_KEY the function still works: it writes the candidates with their own
// abstracts as the framing, flagged so the app can say the summaries are unreviewed. A missing
// key degrades the feed, it does not break it.
//
// WRITES TO `items`, NOT TO A FILE. kind = 'watchFeed', one row per lab, stamped with that lab,
// so the row-level security already in place covers it and a refresh needs no deploy.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
// NCBI asks for a contact address and gives a higher rate limit with a key. Both optional.
const NCBI_KEY = Deno.env.get("NCBI_API_KEY") ?? "";
const NCBI_EMAIL = Deno.env.get("NCBI_EMAIL") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-supabase-api-version",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

type Cfg = {
  id: string; workspace: string;
  authors: string[]; institution: string; excludeAuthors: string[];
  keywords: string[]; excludeKeywords: string[]; societies: string[];
  enabled?: boolean; lastRunAt?: string;
};

// ---------- row ids ----------
// `items` is PRIMARY KEY (id) — id alone, not (id, kind). Two rows of different kinds sharing an
// id are ONE row, and the later write wins. The feed used to be written under the config's own id,
// so every run wrote the feed and then overwrote it with the config a millisecond later: the
// function reported papersOut: 8 and left nothing behind. The seed must differ per kind.
//
// This is a character-for-character port of derivedRowId() in research-tracker.html. The two must
// agree or the app looks the feed up under an id nothing was written to, so if you change one,
// change both — test_watch_row_ids.js compares them.
function derivedRowId(seed: string): string {
  const s = String(seed || "");
  let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0x9e3779b9, h4 = 0x85ebca6b;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = ((h1 ^ c) * 16777619) >>> 0;
    h2 = (h2 + c * 2654435761) >>> 0;
    h3 = ((h3 ^ (c + i)) * 2246822519) >>> 0;
    h4 = (h4 + (c << (i % 13))) >>> 0;
  }
  const hx = (n: number) => ("00000000" + (n >>> 0).toString(16)).slice(-8);
  const raw = hx(h1) + hx(h2) + hx(h3) + hx(h4);
  return raw.slice(0, 8) + "-" + raw.slice(8, 12) + "-5" + raw.slice(13, 16) + "-8" +
    raw.slice(17, 20) + "-" + raw.slice(20, 32);
}
const watchFeedRowId = (ws: string) => derivedRowId("watchFeed:" + ws);

// ---------- small helpers ----------
const clean = (a: unknown): string[] =>
  Array.isArray(a) ? a.map((x) => String(x || "").trim()).filter(Boolean) : [];

// Quote anything with a space so PubMed treats it as a phrase rather than an AND of words.
const phrase = (s: string) => (s.includes(" ") ? `"${s}"` : s);

// PubMed's author index is "Yanke AB", not "Adam Yanke". Searching the human form returns
// exactly nothing — "Adam Yanke"[Author] gave 0 results where Yanke AB[Author] gave 258 — and
// zero results looks indistinguishable from a quiet week, which is how this would have shipped
// unnoticed. Configs store the name people actually know, so the translation happens here.
//
// Both forms are emitted: somebody who types "Yanke AB" directly should still work, and the
// institution filter AND-ed alongside keeps a bare surname+initial from collecting strangers.
function authorTerms(name: string): string[] {
  const n = String(name || "").trim();
  if (!n) return [];
  const out = new Set<string>([`${phrase(n)}[Author]`]);
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    const initials = parts.slice(0, -1).map((w) => w[0]).join("").toUpperCase();
    // "Yanke AB" and "Yanke A" — PubMed indexes both the full initials and the first alone,
    // and which one a given record carries depends on how the journal supplied it.
    out.add(`${phrase(last + " " + initials)}[Author]`);
    if (initials.length > 1) out.add(`${phrase(last + " " + initials[0])}[Author]`);
  }
  return [...out];
}

const daysAgo = (n: number) => {
  const d = new Date(Date.now() - n * 86400e3);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
};

async function getJSON(url: string, tries = 3): Promise<any> {
  let lastErr: unknown = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "studypipeline-research-watch" } });
      if (r.status === 429 || r.status >= 500) throw new Error("HTTP " + r.status);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      lastErr = e;
      // NCBI throttles hard and briefly. Backing off is the difference between an empty feed and
      // a full one, so it is worth the few seconds.
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

// ---------- PubMed ----------
// Two queries on purpose, because they answer different questions and merging them into one
// would let the louder half crowd out the other:
//   OWN  — what this lab has just published, which anchors the framing
//   FIELD— what everybody else published on these topics, which is the actual feed
function pubmedQueries(cfg: Cfg, windowDays: number) {
  const authors = clean(cfg.authors);
  const inst = String(cfg.institution || "").trim();
  const kws = clean(cfg.keywords);
  const notAuthors = clean(cfg.excludeAuthors);
  const notKws = clean(cfg.excludeKeywords);

  const notClause = [
    ...notAuthors.map((a) => `NOT ${phrase(a)}[Author]`),
    ...notKws.map((k) => `NOT ${phrase(k)}[Title/Abstract]`),
  ].join(" ");

  const ownParts = authors.flatMap(authorTerms).join(" OR ");
  // The institution is ANDed, not ORed: it is a filter against the wrong person with the same
  // surname, which is the single most common way these feeds go wrong.
  const own = authors.length
    ? `(${ownParts})${inst ? ` AND ${phrase(inst)}[Affiliation]` : ""} ${notClause}`.trim()
    : "";

  const field = kws.length
    ? `(${kws.map((k) => `${phrase(k)}[Title/Abstract]`).join(" OR ")}) ${notClause}`.trim()
    : "";

  return { own, field, windowDays };
}

async function pubmedSearch(term: string, windowDays: number, retmax: number): Promise<string[]> {
  if (!term) return [];
  const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
  const p = new URLSearchParams({
    db: "pubmed", term, retmode: "json", retmax: String(retmax),
    sort: "pub_date", datetype: "pdat", mindate: daysAgo(windowDays), maxdate: daysAgo(0),
  });
  if (NCBI_KEY) p.set("api_key", NCBI_KEY);
  if (NCBI_EMAIL) p.set("email", NCBI_EMAIL);
  const out = await getJSON(`${base}/esearch.fcgi?${p}`);
  return (out?.esearchresult?.idlist ?? []).map(String);
}

async function pubmedSummaries(pmids: string[]): Promise<any[]> {
  if (!pmids.length) return [];
  const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
  const out: any[] = [];
  // 200 at a time: esummary starts refusing much beyond that, and a 414 here would look like
  // "no new papers this week" rather than like a bug.
  for (let i = 0; i < pmids.length; i += 200) {
    const slice = pmids.slice(i, i + 200);
    const p = new URLSearchParams({ db: "pubmed", id: slice.join(","), retmode: "json" });
    if (NCBI_KEY) p.set("api_key", NCBI_KEY);
    const res = await getJSON(`${base}/esummary.fcgi?${p}`);
    const r = res?.result ?? {};
    for (const id of slice) if (r[id]) out.push(r[id]);
  }
  return out;
}

function summaryToPaper(s: any) {
  const authors = (s.authors ?? []).map((a: any) => String(a?.name || "")).filter(Boolean);
  const doi = (s.articleids ?? []).find((x: any) => x?.idtype === "doi")?.value ?? "";
  return {
    pmid: String(s.uid || ""),
    doi,
    title: String(s.title || "").replace(/\.$/, ""),
    journal: String(s.source || ""),
    pubdate: String(s.pubdate || ""),
    authorList: authors.join(", "),
    firstAuthor: authors[0] ?? "",
    lastAuthor: authors.length > 1 ? authors[authors.length - 1] : "",
  };
}

// ---------- ClinicalTrials.gov ----------
// Two problems with the obvious query, both seen on the first live run, which returned a
// hyperbaric-oxygen trial for femoral head avascular necrosis to a cartilage surgeon:
//
//   1. query.cond treats the terms as CONDITIONS. "osteochondral allograft" is a procedure, not
//      a disease, so the registry falls back to loose relevance matching and anything vaguely
//      orthopaedic scores a hit.
//   2. Unquoted multi-word terms are split, so "meniscal allograft transplantation" matches
//      trials about transplantation of anything.
//
// So: quote every phrase, search the whole record rather than just the condition field, and then
// — the part that actually does the work — keep only trials whose own text contains one of the
// terms. The registry's relevance ranking is a suggestion; the post-filter is the rule.
async function trialSearch(cfg: Cfg, max: number) {
  const kws = clean(cfg.keywords);
  if (!kws.length) return [];
  const quoted = kws.map((k) => (k.includes(" ") ? `"${k}"` : k)).join(" OR ");
  const p = new URLSearchParams({
    "query.term": quoted,
    "filter.overallStatus": "RECRUITING|NOT_YET_RECRUITING",
    // Over-fetch, because the post-filter below throws a lot away and `max` is what we want to
    // END with, not what we want to look at.
    "pageSize": String(Math.min(200, max * 8)),
    "sort": "StartDate:desc",
  });
  const out = await getJSON(`https://clinicaltrials.gov/api/v2/studies?${p}`);
  return (out?.studies ?? []).map((st: any) => {
    const ps = st?.protocolSection ?? {};
    const id = ps?.identificationModule ?? {};
    const status = ps?.statusModule ?? {};
    const design = ps?.designModule ?? {};
    const sponsor = ps?.sponsorCollaboratorsModule?.leadSponsor?.name ?? "";
    return {
      id: String(id?.nctId || ""),
      title: String(id?.briefTitle || ""),
      status: String(status?.overallStatus || ""),
      start: String(status?.startDateStruct?.date || ""),
      primaryCompletion: String(status?.primaryCompletionDateStruct?.date || ""),
      enrollment: design?.enrollmentInfo?.count ?? null,
      phases: (design?.phases ?? []).join("/"),
      studyType: String(design?.studyType || ""),
      sponsor,
      conditions: (ps?.conditionsModule?.conditions ?? []).join(", "),
      summary: String(ps?.descriptionModule?.briefSummary || "").slice(0, 1200),
    };
  }).filter((t: any) => t.id)
    // The rule, not the ranking: a trial survives only if one of this lab's terms appears in its
    // title, its conditions or its summary. Phrases are matched whole — "cartilage restoration"
    // must appear as those two words together, not as "cartilage" somewhere near "restoration".
    .filter((t: any) => {
      const hay = [t.title, t.conditions, t.summary].join(" ").toLowerCase();
      return kws.some((k) => hay.includes(k.toLowerCase()));
    })
    .slice(0, max);
}

// ---------- framing ----------
// The model never receives a question it could answer by inventing a citation. It is handed the
// candidates and asked only to explain and order them, and its output is matched back to the
// supplied ids — anything it returns that was not in the input is dropped rather than trusted.
//
// WHY IT REPORTS WHY IT FAILED: `framed: false` used to be the only signal, and it means at least
// four different things — no key set, key set but not yet picked up by a running instance, key
// rejected, account out of credit. Chasing the wrong one of those costs an afternoon, so the
// reason now travels back with the result instead of being swallowed by the catch.
let lastFrameError = "";
async function frame(cfg: Cfg, own: any[], papers: any[], trials: any[], prefs: Prefs) {
  lastFrameError = "";
  if (!ANTHROPIC_KEY) { lastFrameError = "no ANTHROPIC_API_KEY in this instance's environment"; return null; }
  const body = {
    model: "claude-sonnet-5-5",
    max_tokens: 4000,
    messages: [{
      role: "user",
      content:
`You are preparing a weekly research digest for a surgeon-scientist.

THEIR RECENT PUBLICATIONS (anchor the relevance to these):
${own.slice(0, 15).map((p) => `- ${p.pmid}: ${p.title} (${p.journal}, ${p.pubdate})`).join("\n") || "- none on file"}

THEIR STATED INTERESTS: ${clean(cfg.keywords).join(", ") || "not specified"}
${prefs.likedTitles.length ? `\nTHEY ASKED FOR MORE LIKE THESE:\n${prefs.likedTitles.map((t) => "- " + t).join("\n")}` : ""}
${prefs.dislikedTitles.length ? `\nTHEY ASKED FOR LESS LIKE THESE:\n${prefs.dislikedTitles.map((t) => "- " + t).join("\n")}` : ""}

CANDIDATE PAPERS:
${papers.map((p) => `- ${p.pmid}: ${p.title} (${p.journal}, ${p.pubdate}) — ${p.authorList.slice(0, 120)}`).join("\n")}

CANDIDATE TRIALS:
${trials.map((t) => `- ${t.id}: ${t.title} (${t.status}, n=${t.enrollment ?? "?"}, ${t.sponsor})`).join("\n")}

Return ONLY JSON: {"papers":[{"pmid","verdict","short","forWork","versus"}],"trials":[{"id","short","forWork"}]}

Rules:
- Use ONLY the pmids and NCT ids given above. Never introduce another.
- verdict is one of: consistent, mixed, similar, extends, different — how it sits against THEIR work.
- short: one sentence, under 25 words, what it found and why it matters to them.
- forWork: two sentences max, a concrete next step or comparison with their own data.
- versus: how it agrees or disagrees with their publications, citing their PMIDs. "" if no overlap.
- Order most useful first. Drop anything genuinely irrelevant rather than padding.
- Weigh the "more like these" and "less like these" lists heavily when ordering. They are this
  person's own stated preference and outrank your judgement of what is interesting.
- Never state a finding the title and metadata do not support. If unsure, say what is unclear.`,
    }],
  };
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      // The body carries the actual cause — invalid key, credit balance too low, rate limit.
      // Truncated because it is a diagnostic, not a payload, and it is returned to an admin.
      const detail = await r.text().catch(() => "");
      lastFrameError = `model API ${r.status}: ${detail.slice(0, 300)}`;
      return null;
    }
    const out = await r.json();
    const text = (out?.content ?? []).map((c: any) => c?.text ?? "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { lastFrameError = "model replied without the JSON block the prompt asks for"; return null; }
    return JSON.parse(m[0]);
  } catch (e) {
    // A framing failure must not cost the retrieval. The feed ships unframed.
    lastFrameError = "framing threw: " + String((e as Error)?.message || e).slice(0, 200);
    return null;
  }
}

// ---------- assemble ----------
function buildFeed(cfg: Cfg, own: any[], papers: any[], trials: any[], framed: any) {
  const byPmid = new Map(papers.map((p) => [p.pmid, p]));
  const byNct = new Map(trials.map((t) => [t.id, t]));

  // Only ids we actually retrieved survive. This is the guard that makes a hallucinated citation
  // impossible rather than merely unlikely.
  const framedPapers = (framed?.papers ?? []).filter((f: any) => byPmid.has(String(f?.pmid)));
  const framedTrials = (framed?.trials ?? []).filter((f: any) => byNct.has(String(f?.id)));

  const newPapers = (framedPapers.length ? framedPapers : papers.map((p) => ({ pmid: p.pmid })))
    .slice(0, 8)
    .map((f: any) => {
      const p = byPmid.get(String(f.pmid))!;
      return {
        pmid: p.pmid, doi: p.doi,
        verdict: f.verdict || "similar",
        meta: [p.journal, p.pubdate, p.firstAuthor ? p.firstAuthor + " et al." : ""].filter(Boolean).join(" · "),
        title: p.title,
        frame: f.frame || `${p.journal}, ${p.pubdate}. ${p.authorList.slice(0, 200)}`,
        versus: f.versus || "",
        refs: [],
        forWork: f.forWork || "",
        short: f.short || p.title.slice(0, 120),
      };
    });

  const inDevelopment = (framedTrials.length ? framedTrials : trials.map((t) => ({ id: t.id })))
    .slice(0, 6)
    .map((f: any) => {
      const t = byNct.get(String(f.id))!;
      return {
        id: t.id,
        kind: t.phases ? `Phase ${t.phases}` : (t.studyType === "OBSERVATIONAL" ? "Observational" : "Interventional"),
        meta: [t.status.replace(/_/g, " ").toLowerCase(), t.enrollment ? `n=${t.enrollment}` : "",
               t.start ? `started ${t.start}` : ""].filter(Boolean).join(" · "),
        title: t.title,
        frame: t.sponsor ? `${t.sponsor}. ${t.summary.slice(0, 400)}` : t.summary.slice(0, 400),
        forWork: f.forWork || "",
        short: f.short || t.title.slice(0, 120),
      };
    });

  return {
    schema: 1,
    workspace: cfg.workspace,
    generated: new Date().toISOString().slice(0, 10),
    window: `last ${30} days`,
    reviewed: false,
    // Says plainly whether a model touched this. The app shows it, because "unreviewed summary"
    // and "no summary at all" are different things to the person reading.
    framed: !!framed,
    inDevelopment,
    newPapers,
    alsoNoted: own.slice(0, 3).map((p) => ({
      pmid: p.pmid,
      text: `Your own: ${p.title} (${p.journal}, ${p.pubdate}).`,
    })),
    meetingAbstracts: {
      items: [],
      note: clean(cfg.societies).length
        ? `Meeting abstracts for ${clean(cfg.societies).join(", ")} are not swept yet.`
        : "No societies configured, so no meeting abstracts were swept.",
      leadUrl: "",
    },
  };
}

// Everyone in the lab votes separately, so the signal fed back is the whole lab's, pooled. An
// item voted down by one person and up by another is left alone rather than silently suppressed —
// a PI's dislike should not decide what their RA gets to see.
type Prefs = { likedTitles: string[]; dislikedTitles: string[]; downKeys: Set<string> };
async function readPrefs(db: any, ws: string, priorFeed: any): Promise<Prefs> {
  const empty: Prefs = { likedTitles: [], dislikedTitles: [], downKeys: new Set() };
  try {
    const { data } = await db.from("items").select("data").eq("kind", "watchVote").eq("workspace", ws);
    if (!data?.length) return empty;
    const up = new Map<string, number>(), down = new Map<string, number>();
    for (const row of data) {
      for (const k of clean(row?.data?.up)) up.set(k, (up.get(k) ?? 0) + 1);
      for (const k of clean(row?.data?.down)) down.set(k, (down.get(k) ?? 0) + 1);
    }
    // Titles, not bare ids: the model cannot look a PMID up, and "more like 42862313" means
    // nothing to it. The previous feed is where those titles come from.
    const titleFor = (k: string) => {
      const p = (priorFeed?.newPapers ?? []).find((x: any) => x.pmid === k);
      if (p) return String(p.title || "");
      const t = (priorFeed?.inDevelopment ?? []).find((x: any) => x.id === k);
      return t ? String(t.title || "") : "";
    };
    const liked: string[] = [], disliked: string[] = [];
    const downKeys = new Set<string>();
    for (const [k, n] of up) { const t = titleFor(k); if (t) liked.push(t); void n; }
    for (const [k, n] of down) {
      const t = titleFor(k); if (t) disliked.push(t);
      // Only suppress when nobody wanted it. One person's dislike is a ranking hint, not a veto.
      if (!up.has(k)) downKeys.add(k);
      void n;
    }
    return { likedTitles: liked.slice(0, 12), dislikedTitles: disliked.slice(0, 12), downKeys };
  } catch (_e) {
    return empty;
  }
}

async function runOne(db: any, cfg: Cfg, windowDays: number) {
  const q = pubmedQueries(cfg, windowDays);
  const ownIds = await pubmedSearch(q.own, 365 * 2, 20);
  const fieldIds = await pubmedSearch(q.field, windowDays, 40);
  // Their own papers must not reappear as "new work that touches your publications".
  const ownSet = new Set(ownIds);
  const candidateIds = fieldIds.filter((id) => !ownSet.has(id));

  const [ownSum, fieldSum] = await Promise.all([
    pubmedSummaries(ownIds),
    pubmedSummaries(candidateIds),
  ]);
  const own = ownSum.map(summaryToPaper);
  const papers = fieldSum.map(summaryToPaper);
  const trials = await trialSearch(cfg, 12);

  // Last week's feed, so a vote on "that paper" can be turned into a title the model understands.
  const { data: priorRows } = await db.from("items").select("data")
    .eq("kind", "watchFeed").eq("workspace", cfg.workspace).limit(1);
  const prior = priorRows?.[0]?.data ?? null;
  const prefs = await readPrefs(db, cfg.workspace, prior);

  // Anything the whole lab voted down is dropped before framing, so it is not merely ranked
  // lower — somebody said they did not want to see it again.
  const keptPapers = papers.filter((p) => !prefs.downKeys.has(p.pmid));
  const keptTrials = trials.filter((t) => !prefs.downKeys.has(t.id));

  const framed = await frame(cfg, own, keptPapers.slice(0, 25), keptTrials, prefs);
  const feed = buildFeed(cfg, own, keptPapers, keptTrials, framed);

  const nowIso = new Date().toISOString();
  // Its own id, not the config's — see derivedRowId above for what sharing one cost.
  const feedRowId = watchFeedRowId(cfg.workspace);
  const feedWrite = await db.from("items").upsert({
    id: feedRowId, kind: "watchFeed", data: Object.assign({ id: feedRowId }, feed),
    updated_at: nowIso, workspace: cfg.workspace,
  });
  const cfgWrite = await db.from("items").upsert({
    id: cfg.id, kind: "watchConfig",
    data: Object.assign({}, cfg, { lastRunAt: nowIso }),
    updated_at: nowIso, workspace: cfg.workspace,
  });
  // A write that failed must not be reported as a run that worked. The previous version ignored
  // both results, so a feed that was never stored still came back as ok with eight papers in it.
  const writeError = feedWrite.error?.message || cfgWrite.error?.message || "";
  if (writeError) throw new Error("feed built but not stored: " + writeError);

  return {
    workspace: cfg.workspace, own: own.length, candidates: papers.length,
    trials: trials.length, framed: !!framed, frameError: lastFrameError || undefined,
    feedRowId, stored: true,
    papersOut: feed.newPapers.length, trialsOut: feed.inDevelopment.length,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const db = createClient(SUPABASE_URL, SERVICE_KEY);
    const body = await req.json().catch(() => ({}));
    const only = typeof body?.workspace === "string" ? body.workspace.trim() : "";
    const windowDays = Number(body?.windowDays) > 0 ? Number(body.windowDays) : 30;

    // SERVICE ROLE BYPASSES RLS. Every read below is filtered by workspace in code, because the
    // database will not do it for us here — the same rule as every other function in this project.
    const { data: rows, error } = await db.from("items").select("id, data, workspace")
      .eq("kind", "watchConfig");
    if (error) throw error;

    const configs: Cfg[] = (rows ?? [])
      .map((r: any) => Object.assign({}, r.data, { id: r.id, workspace: r.workspace }))
      .filter((c: Cfg) => c.enabled !== false)
      .filter((c: Cfg) => (only ? c.workspace === only : true))
      // Nothing to search on is not an error, it is a lab that has not configured itself yet.
      .filter((c: Cfg) => clean(c.authors).length || clean(c.keywords).length);

    const results = [];
    for (const cfg of configs) {
      try {
        results.push(await runOne(db, cfg, windowDays));
      } catch (e) {
        // One lab's bad config must not stop the others. Recorded, reported, moved past.
        results.push({ workspace: cfg.workspace, error: String((e as Error)?.message || e) });
      }
    }
    return json({ ok: true, ran: results.length, results });
  } catch (e) {
    return json({ error: (e as Error)?.message || "research-watch failed" }, 500);
  }
});
