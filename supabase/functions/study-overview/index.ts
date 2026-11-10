// A plain-language overview of each study, written from the lab's own research meetings, in the
// PI's voice.   10 Nov 2026
//
// Adam: "use a summary of all of the transcripts from research meetings to make descriptions of
// each study including the clinical relevance and purpose of the study and try to make the wording
// as close as possible to my voice (meaning tone and style) in the meetings, would be helpful for
// transition meetings". And: "I don't want to approve the drafts, so we can do the first five, and
// then if they look fine, it can be automatic after that."
//
// For each study asked for:
//   1. What the tracker knows: title, design, phase, PI, team, notes, abstracts, journal status.
//   2. What was SAID about it: every forwarded meeting that changed it, plus every meeting whose
//      text names it, cut down to the passages around each mention, and the "Heard:" quotes the
//      meeting reader kept for each change. Transcripts were scrubbed of patient details when they
//      arrived and are scrubbed again here.
//   3. A sample of the meetings as a whole, so the model can hear how Adam talks — the speakers
//      aren't labelled, so it's told the PI is the one directing the discussion and making the calls.
// The overview is written onto the study as `overview` by the service role, so it doesn't count
// as anyone's work on the study (freshness, migration 020) and doesn't show as a person's edit.
//
// Never overwrites an overview someone edited by hand unless `force` is set.
//
// Who may call: the email reader (x-ingest-secret), or a signed-in app admin / lab admin of the
// study's lab (their own token, verified here).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("OVERVIEW_MODEL") ?? Deno.env.get("MEETING_MODEL") ?? "claude-sonnet-5-5";
const INGEST_SECRET = Deno.env.get("INGEST_SECRET") ?? "";
const VERSION = 1;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-supabase-api-version, x-ingest-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Patient details out, again. Same shapes the meeting reader strips: MRNs, dates of birth, phone
// numbers, emails. Names were removed on arrival; this is the belt to that braces.
export function scrub(t: string): string {
  return String(t || "")
    .replace(/\b(MRN|medical record)\s*#?:?\s*\d{5,}/gi, "[removed]")
    .replace(/\b(DOB|date of birth)\s*:?\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/gi, "[removed]")
    .replace(/\b\d{3}[\s.\-]\d{3}[\s.\-]\d{4}\b/g, "[removed]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/https?:\/\/\S+/g, "[link]");
}

// Words that identify this study in speech: its nickname, and the distinctive words of its title.
const COMMON = new Set(("the and for with from that this into after before between versus using among based study studies trial " +
  "patients patient outcome outcomes clinical results analysis review systematic retrospective prospective randomized " +
  "comparison effect effects evaluation assessment treatment surgical surgery repair reconstruction knee does actually").split(/\s+/));
export function cuesFor(s: any): RegExp[] {
  const cues: RegExp[] = [];
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nick = String(s.nickname || "").trim();
  if (nick.length >= 4) cues.push(new RegExp(esc(nick), "i"));
  const words = String(s.title || "").toLowerCase().match(/[a-z][a-z\-]{4,}/g) || [];
  const distinct = [...new Set(words.filter((w) => !COMMON.has(w)))].sort((a, b) => b.length - a.length).slice(0, 4);
  // Two distinctive title words close together, so "graft" alone never counts.
  for (let i = 0; i < distinct.length; i++) for (let j = i + 1; j < distinct.length; j++) {
    cues.push(new RegExp(`${esc(distinct[i])}[\\s\\S]{0,200}${esc(distinct[j])}|${esc(distinct[j])}[\\s\\S]{0,200}${esc(distinct[i])}`, "i"));
  }
  return cues;
}
export function passages(text: string, cues: RegExp[], maxChars: number): string[] {
  const t = String(text || "");
  const hits: number[] = [];
  for (const c of cues) {
    const g = new RegExp(c.source, "gi");
    let m;
    while ((m = g.exec(t)) && hits.length < 40) { hits.push(m.index); if (m[0].length === 0) g.lastIndex++; }
  }
  hits.sort((a, b) => a - b);
  const out: string[] = [];
  let used = 0, lastEnd = -1;
  for (const h of hits) {
    const a = Math.max(0, h - 900, lastEnd), b = Math.min(t.length, h + 1600);
    if (b <= a) continue;
    out.push(t.slice(a, b));
    used += b - a; lastEnd = b;
    if (used >= maxChars) break;
  }
  return out;
}

const TOOL = {
  name: "write_overview",
  description: "The study overview, in the PI's voice.",
  input_schema: {
    type: "object",
    properties: {
      purpose: { type: "string", description: "What the study is asking and why we're doing it. 2-4 sentences." },
      relevance: { type: "string", description: "Why it matters clinically: what it would change for patients or for how surgeons decide. 2-3 sentences." },
      status: { type: "string", description: "Where it stands right now and what's been decided. 1-3 sentences." },
      nextSteps: { type: "string", description: "What happens next and who owns it, if the meetings say. 1-3 sentences, or empty." },
      basis: { type: "string", enum: ["meetings", "record"], description: "'meetings' if the meeting passages said something real about this study; 'record' if you wrote it mainly from the study's record." },
    },
    required: ["purpose", "relevance", "status", "nextSteps", "basis"],
  },
};

function studyFacts(s: any): string {
  const list = (v: any) => Array.isArray(v) ? v.join(", ") : String(v || "");
  const notes = (Array.isArray(s.noteEntries) ? s.noteEntries : []).filter((n: any) => !n.archivedOn).slice(-8)
    .map((n: any) => `- ${n.date || ""}: ${String(n.text || "").slice(0, 400)}`).join("\n");
  const abs = (Array.isArray(s.abstracts) ? s.abstracts : []).map((a: any) => `${a.meeting}: ${a.status}${a.format ? " (" + a.format + ")" : ""}`).join("; ");
  return [
    `Title: ${s.title || ""}`, s.nickname ? `Nickname: ${s.nickname}` : "", `Design: ${s.design || ""}`, `Phase: ${s.phase || ""}`,
    `PI: ${s.pi || ""}`, `Team: ${list(s.team)}`,
    s.enrollTarget ? `Enrollment: ${s.enrollCurrent || 0} of ${s.enrollTarget}` : "",
    s.journal ? `Journal: ${s.journal}${s.decision ? " — " + s.decision : ""}` : "",
    abs ? `Abstracts: ${abs}` : "", notes ? `Recent notes:\n${notes}` : "",
  ].filter(Boolean).join("\n");
}

async function writeOne(db: any, s: any, meetings: any[], voice: string, piName: string) {
  const cues = cuesFor(s);
  const said: string[] = [];
  const sources: string[] = [];
  for (const m of meetings) {
    const d = m.data || {};
    const named = Array.isArray(d.studyIds) && d.studyIds.indexOf(s.id) >= 0;
    const heard = (Array.isArray(d.applied) ? d.applied : []).filter((a: any) => a.studyId === s.id && a.evidence)
      .map((a: any) => `"${String(a.evidence).slice(0, 400)}"`);
    const ps = passages(scrub(d.text || ""), cues, 6000);
    if (!named && !ps.length) continue;
    sources.push(m.id);
    said.push(`=== ${String(d.createdAt || "").slice(0, 10)} · ${String(d.subject || "meeting").slice(0, 80)} ===\n` +
      (heard.length ? `What the reader heard about this study: ${heard.join(" ")}\n` : "") +
      ps.map((p) => "…" + p + "…").join("\n\n"));
    if (said.join("").length > 30000) break;
  }
  const prompt =
    `You are writing the overview of one research study for ${piName}'s orthopaedic research lab. It is read at transition meetings, ` +
    `when a new fellow, resident or research assistant takes over a project, so it must make sense to someone new.\n\n` +
    `WRITE IT IN ${piName.toUpperCase()}'S VOICE. Below are passages from the lab's own research meetings. The speakers aren't labelled; ` +
    `${piName} is the PI — usually the person directing the discussion, asking the pointed question, and making the call. Match how he ` +
    `talks: his directness, his vocabulary, the way he frames why a question matters, how much he hedges (or doesn't). Plain spoken ` +
    `English, first person plural ("we're asking…"), no academic boilerplate, no hype, no bullet points. Do not quote the transcript.\n\n` +
    `FACTS ONLY. Use the study record and what was said in the meetings. Never invent a result, a number, a person or a date. If the ` +
    `meetings say nothing about part of it, say less rather than guess. Never include anything that could identify a patient.\n\n` +
    `--- THE STUDY RECORD ---\n${studyFacts(s)}\n\n` +
    `--- WHAT WAS SAID ABOUT IT IN MEETINGS ---\n${said.join("\n\n") || "(not discussed in any forwarded meeting yet)"}\n\n` +
    `--- HOW ${piName.toUpperCase()} TALKS (other passages from the same meetings, for voice only — not facts about this study) ---\n${voice}\n\n` +
    `Call write_overview with the four parts.`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 3000, tools: [TOOL], tool_choice: { type: "auto" },
      messages: [{ role: "user", content: prompt }] }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("model " + res.status + ": " + (out?.error?.message || "failed"));
  const use = (out.content || []).find((c: any) => c.type === "tool_use");
  if (!use) throw new Error("no overview returned");
  const r = use.input || {};
  const clean = (v: any) => scrub(String(v || "")).trim().slice(0, 1500);
  const overview = {
    purpose: clean(r.purpose), relevance: clean(r.relevance), status: clean(r.status), nextSteps: clean(r.nextSteps),
    basis: r.basis === "meetings" && sources.length ? "meetings" : "record",
    meetings: sources.length, sourceIds: sources.slice(0, 50),
    generatedAt: new Date().toISOString(), model: MODEL, version: VERSION, auto: true,
  };
  // Re-read just before writing, and change only `overview`, so a teammate's edit made while the
  // model was thinking isn't lost.
  const { data: fresh } = await db.from("items").select("data").eq("id", s.id).maybeSingle();
  const next = Object.assign({}, (fresh && fresh.data) || s, { overview });
  const { error } = await db.from("items").update({ data: next, updated_at: new Date().toISOString() }).eq("id", s.id);
  if (error) throw error;
  return overview;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!ANTHROPIC_KEY) return json({ error: "No model key" }, 503);
  try {
    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const body = await req.json().catch(() => ({}));
    const ids: string[] = (Array.isArray(body.studyIds) ? body.studyIds : []).map(String).slice(0, 25);
    if (!ids.length) return json({ error: "No studies named" }, 400);

    // Who is asking.
    let allowedLabs: string[] | "all" = [];
    if (INGEST_SECRET && req.headers.get("x-ingest-secret") === INGEST_SECRET) allowedLabs = "all";
    else {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      const { data: caller } = token ? await db.auth.getUser(token) : { data: null } as any;
      const uid = caller?.user?.id;
      if (!uid) return json({ error: "Not signed in" }, 401);
      const { data: appAdmin } = await db.from("app_admins").select("user_id").eq("user_id", uid).maybeSingle();
      if (appAdmin) allowedLabs = "all";
      else {
        const { data: prof } = await db.from("items").select("data, workspace").eq("id", uid).eq("kind", "profile").maybeSingle();
        if (prof && prof.data && prof.data.admin) allowedLabs = [String(prof.workspace)];
      }
      if (allowedLabs !== "all" && !allowedLabs.length) return json({ error: "Only lab admins can refresh overviews" }, 403);
    }

    const { data: rows, error } = await db.from("items").select("id, data, workspace").eq("kind", "study").in("id", ids);
    if (error) throw error;
    const results: any[] = [];
    const byLab: Record<string, any[]> = {};
    for (const r of rows || []) {
      if (allowedLabs !== "all" && allowedLabs.indexOf(r.workspace) < 0) { results.push({ id: r.id, skipped: "not your lab" }); continue; }
      (byLab[r.workspace] = byLab[r.workspace] || []).push(r);
    }
    for (const lab of Object.keys(byLab)) {
      const { data: mrows } = await db.from("items").select("id, data").eq("kind", "suggestion").eq("workspace", lab)
        .eq("data->>source", "meeting").order("updated_at", { ascending: true }).limit(400);
      const meetings = (mrows || []).filter((m: any) => m.data && !m.data.rerun && !m.data.retried && String(m.data.text || "").length > 400);
      const { data: piRow } = await db.from("lab_pis").select("pi_name").eq("workspace", lab).maybeSingle();
      const piName = (piRow && piRow.pi_name) || "the PI";
      // A voice sample: the opening of the longest few transcripts (the bits where the PI runs the meeting).
      const voice = meetings.filter((m: any) => /Speaker \d/.test(m.data.text || ""))
        .sort((a: any, b: any) => String(b.data.text).length - String(a.data.text).length).slice(0, 3)
        .map((m: any) => scrub(String(m.data.text)).slice(0, 3500)).join("\n\n…\n\n") || "(no transcripts yet)";
      for (const r of byLab[lab]) {
        const s = Object.assign({ id: r.id }, r.data);
        if (s.overview && s.overview.editedBy && !body.force) { results.push({ id: r.id, skipped: "edited by hand" }); continue; }
        try { results.push({ id: r.id, ok: true, overview: await writeOne(db, s, meetings, voice, piName) }); }
        catch (e) { results.push({ id: r.id, error: (e as Error).message }); }
      }
    }
    return json({ ok: true, results });
  } catch (e) {
    return json({ error: (e as Error).message || "failed" }, 500);
  }
});
