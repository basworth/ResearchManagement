// Pulls Adam's published papers from PubMed and files them as Published studies, each carrying
// its full author list — so "who published this with me" is answerable from the tracker.
//
// Why a server-side function rather than the app: NCBI's E-utilities send no CORS headers, so a
// browser can only read them from a tab already on ncbi.nlm.nih.gov — and such a tab cannot talk
// to Supabase. Nothing in the browser can do both halves. Here there is no CORS at all.
//
// It is also written to be re-run. Every paper is matched before anything is written, so running
// it monthly picks up new publications and changes nothing that already exists.
//
// POST body: { dryRun?: boolean, author?: string, workspace?: string }
//   dryRun (default TRUE) reports what it would do and writes nothing. Pass false to apply.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// No XML DOM library on purpose. Deno has no built-in DOMParser, and deno_dom pulls in a WASM
// parser that took the deployed bundle to 1.45 MB — at which point the function answered from
// some origins and failed with a bare "Failed to fetch" from the app. PubMed's XML is
// machine-generated and completely regular, so reading it with string matching is both
// sufficient and an order of magnitude smaller.

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";

// Called from the tracker's own origin, so it needs the same CORS block every other function
// here has. Without it the browser refuses before the request is even sent, and the only clue is
// a bare "Failed to fetch" that looks like the network is down.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// Full forename, not initials. "Yanke AB" matches both Adam B Yanke and Amy B Yanke — a
// veterinary neurologist whose papers were nearly imported as his. The full-name index separates
// them exactly, where guessing from affiliations needed a human for 45 of 293 records.
const DEFAULT_AUTHOR = "Yanke Adam B";

type Author = { last: string; fore: string; initials: string };
type Paper = {
  pmid: string; doi: string; title: string; journal: string; year: string;
  authors: Author[]; authorList: string;
};

// XML entities, limited to the five that matter plus numeric escapes. PubMed titles carry things
// like &lt;i&gt; around gene names and &amp; in journal titles.
function unescapeXml(t: string): string {
  return t
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");                       // last, or the others would double-decode
}
// First <tag>…</tag> inside a chunk. Tags here never nest with themselves, which is what makes
// this safe without a real parser.
function tag(chunk: string, name: string): string {
  const m = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">").exec(chunk);
  return m ? unescapeXml(m[1].replace(/<[^>]+>/g, "")).trim() : "";
}
function tagAll(chunk: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk))) out.push(m[1]);
  return out;
}

function parseArticles(xml: string): Paper[] {
  return tagAll(xml, "PubmedArticle").map((a) => {
    const authors: Author[] = tagAll(a, "Author").map((au) => ({
      last: tag(au, "LastName"), fore: tag(au, "ForeName"), initials: tag(au, "Initials"),
    })).filter((x) => x.last);
    // The DOI sits in an ArticleId carrying IdType="doi"; take that one specifically.
    const doi = (/<ArticleId[^>]*IdType="doi"[^>]*>([\s\S]*?)<\/ArticleId>/.exec(a)?.[1] ?? "").trim();
    // PMID appears again inside each reference, so anchor on the one in MedlineCitation.
    const cite = /<MedlineCitation[\s\S]*?<\/MedlineCitation>/.exec(a)?.[0] ?? a;
    const pmid = tag(cite.slice(0, 400), "PMID");
    const pubDate = /<PubDate>([\s\S]*?)<\/PubDate>/.exec(a)?.[1] ?? "";
    return {
      pmid, doi,
      title: tag(a, "ArticleTitle"),
      journal: tag(a, "ISOAbbreviation") || tag(a, "Title"),
      year: tag(pubDate, "Year") || tag(pubDate, "MedlineDate").slice(0, 4),
      authors,
      authorList: authors.map((x) => [x.fore || x.initials, x.last].filter(Boolean).join(" ")).join(", "),
    };
  }).filter((p) => p.pmid);
}

// Title matching has to tolerate the differences that are not differences: PubMed keeps the
// trailing full stop and the original capitalisation, while a tracker title is whatever someone
// typed while the work was still in progress.
const norm = (t: string) =>
  (t || "").toLowerCase().replace(/<[^>]+>/g, " ").replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ").trim();

function titleOverlap(a: string, b: string): number {
  const words = (t: string) => new Set(norm(t).split(" ").filter((w) => w.length > 4));
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let hits = 0;
  A.forEach((w) => { if (B.has(w)) hits++; });
  return hits / Math.min(A.size, B.size);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("POST only", { status: 405, headers: CORS });

  // Admin only, and identified by their own token rather than a shared secret: this writes
  // hundreds of studies, and it should be obvious afterwards who ran it.
  const authHeader = req.headers.get("Authorization") ?? "";
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: userData } = await userClient.auth.getUser();
  const caller = userData?.user;
  if (!caller) return json({ error: "Sign in first" }, 401);

  const { data: profRow } = await db.from("items").select("data, workspace")
    .eq("kind", "profile").eq("id", caller.id).maybeSingle();
  if (!profRow?.data?.admin) {
    return json({ error: "Admins only" }, 403);
  }

  const body = await req.json().catch(() => ({}));
  const dryRun = body.dryRun !== false;              // writing is the explicit choice, not the default
  const author = String(body.author || DEFAULT_AUTHOR);
  const workspace = String(body.workspace || profRow.workspace || "sports-yanke");

  // ---- 1. every PMID for this author ----
  const term = encodeURIComponent(`"${author}"[Full Author Name]`);
  const search = await fetch(`${EUTILS}esearch.fcgi?db=pubmed&retmax=1000&retmode=json&term=${term}`)
    .then((r) => r.json());
  const pmids: string[] = search?.esearchresult?.idlist ?? [];
  if (!pmids.length) return json({ error: "PubMed returned nothing for " + author }, 502);

  // ---- 2. the records, in batches, politely ----
  const papers: Paper[] = [];
  for (let i = 0; i < pmids.length; i += 100) {
    const xml = await fetch(`${EUTILS}efetch.fcgi?db=pubmed&retmode=xml&id=${pmids.slice(i, i + 100).join(",")}`)
      .then((r) => r.text());
    papers.push(...parseArticles(xml));
    await new Promise((r) => setTimeout(r, 350));
  }

  // ---- 3. what the tracker already holds ----
  const { data: existing } = await db.from("items").select("id, data, workspace")
    .eq("kind", "study").eq("workspace", workspace);
  const studies = (existing ?? []).map((r) => ({ id: r.id, data: r.data }));

  const byPmid = new Map<string, typeof studies[0]>();
  studies.forEach((s) => { const p = s.data?.publication?.pmid; if (p) byPmid.set(String(p), s); });

  const created: string[] = [];
  const attached: { pmid: string; title: string; to: string; overlap: number }[] = [];
  const alreadyLinked: string[] = [];
  const ambiguous: { pmid: string; title: string; candidates: string[] }[] = [];
  const writes: any[] = [];

  for (const p of papers) {
    if (byPmid.has(p.pmid)) { alreadyLinked.push(p.pmid); continue; }

    // Does a study already track this work? Score every title; a clear winner attaches, a tie
    // goes to Adam rather than being guessed at.
    const scored = studies
      .filter((s) => !s.data?.publication)
      .map((s) => ({ s, score: titleOverlap(p.title, s.data?.title || "") }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    const second = scored[1];

    const publication = {
      pmid: p.pmid, doi: p.doi, title: p.title, journal: p.journal, year: p.year,
      authors: p.authors, authorList: p.authorList, importedOn: new Date().toISOString().slice(0, 10),
    };

    if (best && best.score >= 0.75 && (!second || best.score >= second.score * 1.3)) {
      attached.push({ pmid: p.pmid, title: p.title.slice(0, 70), to: best.s.data.title?.slice(0, 70), overlap: +best.score.toFixed(2) });
      writes.push({
        id: best.s.id, kind: "study", workspace, updated_at: new Date().toISOString(),
        data: { ...best.s.data, publication, phase: "Published", journal: best.s.data.journal || p.journal },
      });
      byPmid.set(p.pmid, best.s);
      continue;
    }
    if (best && best.score >= 0.75) {
      ambiguous.push({ pmid: p.pmid, title: p.title.slice(0, 70), candidates: scored.slice(0, 3).map((x) => x.s.data.title?.slice(0, 60)) });
      continue;
    }

    // Nothing matches: a paper from before the tracker existed. New Published study.
    created.push(p.pmid);
    writes.push({
      id: crypto.randomUUID(), kind: "study", workspace, updated_at: new Date().toISOString(),
      data: {
        id: crypto.randomUUID(), title: p.title, nickname: "", pi: "Adam Yanke", team: [],
        design: "Retrospective (Non-Consented)", phase: "Published", priority: "Low",
        irb: "", irbStatus: "", start: "", notes: "", journal: p.journal,
        milestones: [], noteEntries: [], abstracts: [], docs: [], meetingNotes: [], authors: [],
        publication,
      },
    });
  }
  // The row id and the record's own id must agree, or realtime updates match nothing.
  writes.forEach((w) => { if (w.data?.id) w.data.id = w.id; });

  let written = 0;
  if (!dryRun && writes.length) {
    for (let i = 0; i < writes.length; i += 50) {
      const { error } = await db.from("items").upsert(writes.slice(i, i + 50));
      if (error) return json({ error: error.message, writtenBeforeFailure: written }, 500);
      written += writes.slice(i, i + 50).length;
    }
  }

  return json({
    dryRun, author, workspace,
    pubmedRecords: papers.length,
    wouldCreate: created.length,
    wouldAttachToExisting: attached.length,
    alreadyLinked: alreadyLinked.length,
    needsYourEye: ambiguous.length,
    written,
    attached,          // every match it made, so the judgement can be checked
    ambiguous,         // and everything it refused to guess at
  });
});
