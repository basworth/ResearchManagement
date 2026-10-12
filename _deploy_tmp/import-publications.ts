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
// Deno has no DOMParser — that is a browser API, and the compile check passes only because its
// type definitions include the DOM lib. Without this import the function would deploy cleanly and
// then throw "DOMParser is not defined" on its first real call.
import { DOMParser, type Element } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";

// Full forename, not initials. "Yanke AB" matches both Adam B Yanke and Amy B Yanke — a
// veterinary neurologist whose papers were nearly imported as his. The full-name index separates
// them exactly, where guessing from affiliations needed a human for 45 of 293 records.
const DEFAULT_AUTHOR = "Yanke Adam B";

type Author = { last: string; fore: string; initials: string };
type Paper = {
  pmid: string; doi: string; title: string; journal: string; year: string;
  authors: Author[]; authorList: string;
};

const text = (el: Element | null) => (el?.textContent ?? "").trim();

function parseArticles(xml: string): Paper[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (!doc) return [];
  return [...doc.querySelectorAll("PubmedArticle")].map((a) => {
    const q = (sel: string) => text(a.querySelector(sel));
    const authors: Author[] = [...a.querySelectorAll("AuthorList > Author")].map((au) => ({
      last: text(au.querySelector("LastName")),
      fore: text(au.querySelector("ForeName")),
      initials: text(au.querySelector("Initials")),
    })).filter((x) => x.last);
    const ids = [...a.querySelectorAll("ArticleIdList > ArticleId")];
    const doi = ids.find((x) => x.getAttribute("IdType") === "doi");
    return {
      pmid: q("MedlineCitation > PMID"),
      doi: text(doi ?? null),
      title: q("ArticleTitle"),
      journal: q("Journal > ISOAbbreviation") || q("Journal > Title"),
      year: q("JournalIssue > PubDate > Year") ||
            q("JournalIssue > PubDate > MedlineDate").slice(0, 4),
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
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

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
  if (!caller) return Response.json({ error: "Sign in first" }, { status: 401 });

  const { data: profRow } = await db.from("items").select("data, workspace")
    .eq("kind", "profile").eq("id", caller.id).maybeSingle();
  if (!profRow?.data?.admin) {
    return Response.json({ error: "Admins only" }, { status: 403 });
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
  if (!pmids.length) return Response.json({ error: "PubMed returned nothing for " + author }, { status: 502 });

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
      if (error) return Response.json({ error: error.message, writtenBeforeFailure: written }, { status: 500 });
      written += writes.slice(i, i + 50).length;
    }
  }

  return Response.json({
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
