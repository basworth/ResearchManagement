// "Ask the study team for an update" — one tap in the app, one email per team member.
//
// Why this is a server function rather than app code: the browser knows people by NAME (studies
// store "Will Lee", not an address), and the mapping from a name to a mailbox lives in profile
// rows that the app can see but must never be trusted to resolve on its own — it would also mean
// shipping SMTP credentials to the client. So the app sends a study id, and everything else is
// decided here from the database.
//
// Recipients are the study's PI and team, minus the caller (no point emailing yourself), minus
// anyone with no account (they have no address to write to). The reply lands in the caller's
// inbox; the email also carries a button that opens that study directly.
//
// Nothing here touches patient data: the tracker is study-level only, so an email contains a
// study nickname, a phase, and whatever the caller typed.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://studypipeline.com";
const SMTP_USER = Deno.env.get("SMTP_USER")!;
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD")!;
const SMTP_HOST = Deno.env.get("SMTP_HOST") ?? "smtp.gmail.com";
const SMTP_PORT = Number(Deno.env.get("SMTP_PORT") ?? "465");
const FROM_NAME = Deno.env.get("REMINDER_FROM_NAME") ?? "MOR Research Tracker";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

// Kept deliberately identical to task-emails/index.ts and to the app: the same person has been
// spelled several ways over the years, so a study whose team lists "Zach O" must still reach
// Zachary Oppenheim. If you change one of the three, change all three.
const NAME_ALIASES: Record<string, string> = {
  "yanke": "Adam Yanke", "adam b. yanke md phd": "Adam Yanke", "adam yanke md phd": "Adam Yanke",
  "cat": "Catherine Yuh",
  "tj": "Thomas Turinske", "tj t": "Thomas Turinske", "tj turinske": "Thomas Turinske",
  "will": "William Lee", "will l": "William Lee",
  "divesh": "Divesh Sachdev", "divesh sachdev bs": "Divesh Sachdev",
  "kofi": "Kofi Acheampong", "kofi acheampong bs": "Kofi Acheampong",
  "zach": "Zachary Oppenheim", "zach o": "Zachary Oppenheim", "zachary oppenheim bs": "Zachary Oppenheim",
  "jay": "Jay Amin", "jay a": "Jay Amin", "jay amin": "Jay Amin",
  "dan": "Daniel Shinn", "daniel shinn": "Daniel Shinn",
  "eddie": "Edouard Augustin", "eddie augustin": "Edouard Augustin", "edouard augustin": "Edouard Augustin",
  "cade": "Cade Smelley", "cade smelley": "Cade Smelley",
  "lesly honore bs": "Lesly Honore",
  "jakob ackerman md": "Jakob Ackerman",
};
const DEGREE_TOKENS = new Set(["ba", "bs", "bsc", "ma", "ms", "msc", "mba", "md", "do", "phd",
  "mph", "msph", "mha", "dpt", "mpt", "rn", "np", "pa", "pac", "mbbs", "scd", "edd", "jd",
  "pharmd", "atc", "crna", "facs", "faaos"]);

function stripDegrees(n: string): string {
  const parts = String(n ?? "").trim().replace(/,/g, " ").split(/\s+/).filter(Boolean);
  while (parts.length > 1 && DEGREE_TOKENS.has(parts[parts.length - 1].toLowerCase().replace(/[.\-]/g, ""))) parts.pop();
  return parts.join(" ");
}
function canonName(n: string): string {
  const raw = String(n ?? "").trim();
  if (!raw) return "";
  const direct = NAME_ALIASES[raw.toLowerCase()];
  if (direct) return direct;
  const stripped = stripDegrees(raw);
  return NAME_ALIASES[stripped.toLowerCase()] ?? stripped;
}
// Study team fields are free text as often as they are arrays — "Yanke, Lee, Turinske" in one
// string is normal in the older records. Splitting on commas and slashes is what the app does.
function namesFromField(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x ?? "").trim()).filter(Boolean);
  return String(v ?? "").split(/[,/;]|\band\b/i).map((x) => x.trim()).filter(Boolean);
}

type Profile = { id: string; name: string; email: string };

// Same substitution as task-emails: alertEmail wins over the sign-in address (Rush hands out two
// and people read only one of them), and a linked spare account is skipped so it can't overwrite
// the primary in this map and send to whichever row happened to load last.
async function loadProfiles(db: any): Promise<Map<string, Profile>> {
  const { data, error } = await db.from("items").select("data").eq("kind", "profile");
  if (error) throw error;
  const byName = new Map<string, Profile>();
  for (const row of data ?? []) {
    const p = row.data as Profile & { alertEmail?: string; linkedTo?: string };
    if (!p?.email || !p?.name) continue;
    if (p.linkedTo) continue;
    const to = (p.alertEmail || "").trim() || p.email;
    byName.set(canonName(p.name).toLowerCase(), { id: p.id, name: p.name, email: to });
  }
  return byName;
}

async function sendMail(to: string, replyTo: string, subject: string, html: string) {
  const smtp = new SMTPClient({
    connection: { hostname: SMTP_HOST, port: SMTP_PORT, tls: true, auth: { username: SMTP_USER, password: SMTP_PASSWORD } },
  });
  try {
    await smtp.send({
      from: `${FROM_NAME} <${SMTP_USER}>`,
      to, subject, html,
      // So hitting Reply reaches the person who asked, not the shared sending mailbox.
      replyTo,
      content: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    } as any);
  } finally {
    try { await smtp.close(); } catch { /* already closed */ }
  }
}

function body(askerName: string, askerEmail: string, study: any, note: string): string {
  const label = study.nickname || study.title || "a study";
  const link = `${SITE_URL}/?study=${encodeURIComponent(study.id)}`;
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1c1c1e">
    <div style="font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:#8e8e93;font-weight:700">Midwest Orthopaedics at Rush</div>
    <h1 style="font-size:19px;margin:6px 0 14px 0">Can we get an update?</h1>
    <p style="font-size:14.5px;line-height:1.5;color:#3a3a3c;margin:0 0 16px 0">
      <b>${esc(askerName)}</b> is asking the study team for a status update on:
    </p>
    <div style="border:1px solid #e5e5ea;border-radius:11px;padding:13px 15px;margin-bottom:14px">
      <div style="font-size:15px;font-weight:600">${esc(label)}</div>
      <div style="font-size:12.5px;color:#8e8e93;margin-top:3px">
        ${study.irb ? esc(study.irb) + " &middot; " : ""}${esc(study.phase || "")}
      </div>
    </div>
    ${note ? `<p style="font-size:14px;color:#3a3a3c;background:#f2f2f7;border-radius:9px;padding:11px 13px;line-height:1.5;margin:0 0 16px 0">${esc(note)}</p>` : ""}
    <p style="margin:6px 0 0 0"><a href="${esc(link)}" style="background:#0a84ff;color:#fff;text-decoration:none;font-weight:600;font-size:14.5px;padding:10px 18px;border-radius:9px;display:inline-block">Open this study</a></p>
    <p style="font-size:13px;color:#3a3a3c;line-height:1.5;margin-top:16px">
      Best is to update the study itself — notes, tasks and dates — so everyone sees it.
      Replying to this email reaches ${esc(askerEmail)} directly.
    </p>
    <p style="font-size:11.5px;color:#8e8e93;line-height:1.45;margin-top:20px">You're getting this because you're listed on this study in the Research Tracker.</p>
  </div>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Not signed in" }, 401);

    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: who, error: whoErr } = await db.auth.getUser(token);
    if (whoErr || !who?.user?.email) return json({ error: "Could not verify who you are" }, 401);
    const callerId = who.user.id;
    const callerEmail = who.user.email;

    const payload = await req.json().catch(() => ({}));
    const studyId = String(payload?.studyId ?? "").trim();
    const note = String(payload?.note ?? "").slice(0, 500).trim();
    if (!studyId) return json({ error: "No study given" }, 400);

    const { data: studyRow } = await db.from("items").select("data").eq("kind", "study").eq("id", studyId).maybeSingle();
    const study = studyRow?.data as any;
    if (!study) return json({ error: "That study no longer exists" }, 404);

    const profiles = await loadProfiles(db);
    const { data: callerRow } = await db.from("items").select("data").eq("kind", "profile").eq("id", callerId).maybeSingle();
    const askerName = (callerRow?.data as any)?.name || callerEmail;

    // PI first, then the team, de-duplicated by canonical name.
    const wanted: string[] = [];
    const seen = new Set<string>();
    for (const raw of namesFromField(study.pi).concat(namesFromField(study.team))) {
      const n = canonName(raw);
      if (!n) continue;
      const k = n.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      wanted.push(n);
    }

    const sent: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];
    const subject = `Update requested: ${study.nickname || study.title || "a study"}`;
    const html = body(askerName, callerEmail, study, note);

    for (const name of wanted) {
      const p = profiles.get(name.toLowerCase());
      // No account, so no address. Reported back rather than dropped, because "we asked the team"
      // quietly meaning "we asked four of the six" is exactly the failure worth surfacing.
      if (!p) { skipped.push(name); continue; }
      // Don't email the person doing the asking.
      if (p.id === callerId) continue;
      try {
        await sendMail(p.email, callerEmail, subject, html);
        sent.push(name);
      } catch (e) {
        // One bad mailbox must not abort the rest of the team.
        console.error("request-update send failed", name, e);
        failed.push(name);
      }
    }

    return json({ ok: true, sent, failed, skipped });
  } catch (e) {
    console.error("request-update error", e);
    return json({ error: (e as Error).message ?? "Something went wrong" }, 500);
  }
});
