// Inbound forwarded email → a Suggested Update.
//
// A Google Apps Script sitting on the tracker's Gmail mailbox polls for unread mail and POSTs each
// message here. This function's whole job is to decide whether the sender is someone we know, and
// to file the message either way.
//
// SECURITY, and the reason this is a server function rather than app code:
//
//   Anyone can send mail to a Gmail address, and a From header is trivially forged. So the sender
//   is checked against the team's profile addresses here, with the service role, and a message we
//   can't place is stored `unverified` — visible to admins, able to change nothing. Without that
//   check the forwarding address would be an open write channel into the study records.
//
//   The shared secret below stops anyone who learns the function URL from posting straight to it,
//   bypassing the mailbox entirely.
//
// The parsing and the applying both happen in the app, not here: the rules for what is safe to
// apply live next to the study model they act on, and duplicating them in two languages is how
// they drift apart. This function stores the message; the app reads it.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";
import { setStudies, stripPHI as stripPHIRules, readEmail, PARSER_VERSION } from "./rules.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Set as an edge-function secret, and pasted into the Apps Script. Not a password anyone types.
const INGEST_SECRET = Deno.env.get("INGEST_SECRET") ?? "";
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://rushsportsresearch.netlify.app";
const SMTP_USER = Deno.env.get("SMTP_USER") ?? "";
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD") ?? "";
const SMTP_HOST = Deno.env.get("SMTP_HOST") ?? "smtp.gmail.com";
const SMTP_PORT = Number(Deno.env.get("SMTP_PORT") ?? "465");
const FROM_NAME = Deno.env.get("REMINDER_FROM_NAME") ?? "MOR Research Tracker";

// Telling the forwarder what happened to their email. Without it, forwarding feels like shouting
// into a void and people stop doing it — which is the failure mode that kills this whole feature.
//
// Sent to the address they READ, not the one they forwarded from: someone can forward from a phone
// signed into a personal account while reading their work mail. Deliberately not sent for an
// unverified sender — we'd be emailing a stranger who may not have sent it at all.
async function notifyForwarder(to: string, name: string, subject: string, matched: string,
                               basis: string, applied: any[], waiting: any[], studyId: string) {
  if (!to || !SMTP_USER || !SMTP_PASSWORD) return;
  const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
  const link = studyId ? `${SITE_URL}/?study=${encodeURIComponent(studyId)}` : SITE_URL;
  const line = !matched
    ? `The tracker couldn't work out which study it's about, so nothing was changed. It's in Suggested Updates if you want to look.`
    : applied.length && waiting.length
      ? `${applied.length} change${applied.length === 1 ? "" : "s"} applied, ${waiting.length} waiting for you to confirm.`
      : applied.length
        ? `${applied.length} change${applied.length === 1 ? "" : "s"} applied. Nothing needs your attention.`
        : waiting.length
          ? `${waiting.length} change${waiting.length === 1 ? "" : "s"} waiting for you to confirm — nothing has been changed yet.`
          : `Nothing in it changes what the tracker already has.`;
  const rows = (list: any[], heading: string) => list.length ? `
    <div style="font-size:11px;font-weight:700;color:#8e8e93;letter-spacing:.4px;margin:14px 0 4px">${heading}</div>
    ${list.map(c => `<div style="font-size:14px;padding:3px 0">${esc(c.label)} &rarr; <b>${esc(c.to)}</b></div>`).join("")}` : "";
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1c1c1e">
    <div style="font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:#8e8e93;font-weight:700">Midwest Orthopaedics at Rush</div>
    <h1 style="font-size:19px;margin:6px 0 14px 0">Read your forwarded email</h1>
    <p style="font-size:14.5px;line-height:1.5;color:#3a3a3c;margin:0 0 14px 0">${esc(subject)}</p>
    ${matched ? `<div style="border:1px solid #e5e5ea;border-radius:11px;padding:13px 15px">
      <div style="font-size:15px;font-weight:600">${esc(matched)}</div>
      <div style="font-size:12.5px;color:#8e8e93;margin-top:3px">matched by ${esc(basis)}</div>
    </div>` : ""}
    <p style="font-size:14.5px;line-height:1.5;color:#3a3a3c;margin:14px 0 0 0">${esc(line)}</p>
    ${rows(applied, "APPLIED")}
    ${rows(waiting, "WAITING FOR YOU")}
    <p style="margin:20px 0 0 0"><a href="${esc(link)}" style="background:#0a84ff;color:#fff;text-decoration:none;font-weight:600;font-size:14.5px;padding:10px 18px;border-radius:9px;display:inline-block">${waiting.length ? "Review it" : "Open the tracker"}</a></p>
    <p style="font-size:11.5px;color:#8e8e93;line-height:1.45;margin-top:20px">You're getting this because you forwarded an email to the tracker.</p>
  </div>`;
  const smtp = new SMTPClient({
    connection: { hostname: SMTP_HOST, port: SMTP_PORT, tls: true, auth: { username: SMTP_USER, password: SMTP_PASSWORD } },
  });
  try {
    await smtp.send({
      from: `${FROM_NAME} <${SMTP_USER}>`, to,
      subject: matched ? `Read: ${matched}` : "Read your forwarded email",
      html, content: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    } as any);
  } finally {
    try { await smtp.close(); } catch { /* already closed */ }
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-ingest-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// "Carla Edwards <carla.edwards@rushortho.com>" → "carla.edwards@rushortho.com"
function bareAddress(from: string): string {
  const m = /<([^>]+)>/.exec(String(from ?? ""));
  return (m ? m[1] : String(from ?? "")).trim().toLowerCase();
}

// PHI stripping now lives in rules.ts alongside the matching rules, so the app and the server use
// the same one and test_parser_parity.js can prove it.

// Forwarded mail carries the original message under a header block. The person who forwarded it is
// the envelope sender; the journal is the address inside. We want the forwarder, which is what
// `from` already is — this only pulls out the original sender for display.
function originalSender(body: string): string {
  const m = /^\s*From:\s*(.+)$/im.exec(String(body ?? ""));
  return m ? m[1].trim().slice(0, 200) : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  try {
    if (!INGEST_SECRET) return json({ error: "Ingest is not configured" }, 503);
    if (req.headers.get("x-ingest-secret") !== INGEST_SECRET) return json({ error: "Not allowed" }, 401);

    const payload = await req.json().catch(() => ({}));
    const from = bareAddress(payload?.from ?? "");
    const subject = String(payload?.subject ?? "").slice(0, 200);
    const raw = String(payload?.body ?? "");
    if (!raw.trim()) return json({ error: "Empty message" }, 400);

    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    // Every profile, so the sender can be matched on either the sign-in address or the alert
    // address — people forward from whichever mailbox they happen to be reading.
    const { data: profileRows, error: profErr } = await db.from("items").select("data").eq("kind", "profile");
    if (profErr) throw profErr;
    let sender: { id: string; name: string; notify: string } | null = null;
    for (const row of profileRows ?? []) {
      const p = row.data as { id: string; name?: string; email?: string; alertEmail?: string; linkedTo?: string };
      if (!p?.id) continue;
      const addrs = [p.email, p.alertEmail].map(a => String(a ?? "").trim().toLowerCase()).filter(Boolean);
      if (addrs.indexOf(from) >= 0) {
        // Reply to the address they READ, which may not be the one they forwarded from.
        sender = { id: p.id, name: p.name ?? "", notify: (p.alertEmail || p.email || from).trim() };
        break;
      }
    }

    const clean = stripPHIRules(raw);
    const id = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    // Read it now, so a forward is fully understood within five minutes of being sent whether or
    // not anyone has the tracker open.
    const { data: studyRows, error: studyErr } = await db.from("items").select("id, data").eq("kind", "study");
    if (studyErr) throw studyErr;
    const studies = (studyRows ?? []).map((r: any) => r.data).filter(Boolean);
    setStudies(studies);
    const read = readEmail(clean.text, subject);

    // Safe changes apply themselves — but never for a sender we couldn't place. Same rule as the
    // app: if we don't know who sent it, we don't act on it.
    const applied: any[] = [];
    if (sender && read.study && read.changes.some((c: any) => c.safe)) {
      const target = studies.find((s: any) => s.id === read.study.id);
      if (target) {
        read.changes.filter((c: any) => c.safe).forEach((c: any) => {
          const before = target[c.field];
          target[c.field] = c.to;
          if (c.field === "decision" && c.to && c.to !== "Awaiting decision" && !target.decisionDate) {
            target.decisionDate = new Date().toISOString().slice(0, 10);
          }
          applied.push({ field: c.field, label: c.label, from: before || "", to: c.to });
        });
        read.changes = read.changes.filter((c: any) => !c.safe);
        const { error: upErr } = await db.from("items")
          .update({ data: target, updated_at: nowIso }).eq("id", target.id);
        // A failed write must not leave the suggestion claiming it applied something.
        if (upErr) { applied.length = 0; read.changes = readEmail(clean.text, subject).changes; }
      }
    }
    const suggestion = {
      id,
      createdAt: nowIso,
      source: "email",
      from,
      originalFrom: originalSender(clean.text),
      subject,
      text: clean.text.slice(0, 20000),
      redacted: clean.redacted,
      redactedKinds: clean.kinds,
      forwardedBy: sender ? sender.id : "",
      forwardedByName: sender ? sender.name : "",
      unverified: !sender,
      studyId: read.study ? read.study.id : "",
      basis: read.study ? read.basis : "",
      changes: read.changes,
      applied,
      status: (!read.changes.length && applied.length) ? "applied" : "pending",
      // Already read. The app keeps its own copy of the rules for pasted email and transcripts,
      // and skips anything that arrives with this false — unless its parserVersion is behind, in
      // which case it re-reads it.
      needsParse: false,
      parserVersion: PARSER_VERSION,
    };
    if (!read.changes.length && applied.length) {
      (suggestion as any).decidedAt = nowIso;
      (suggestion as any).decidedBy = "the tracker";
    }

    const { error: insErr } = await db.from("items").insert({
      id, kind: "suggestion", data: suggestion, updated_at: nowIso,
    });
    if (insErr) throw insErr;

    // Sent after the row is safely stored, and never allowed to fail the request: a forward that
    // was captured and read is a success even if the courtesy note bounces.
    let notified = false;
    if (sender) {
      try {
        await notifyForwarder(sender.notify, sender.name, subject,
          read.study ? (read.study.nickname || read.study.title) : "",
          read.study ? read.basis : "", applied, read.changes,
          read.study ? read.study.id : "");
        notified = true;
      } catch (e) {
        console.error("ingest-email notify failed", e);
      }
    }

    return json({
      ok: true, id, verified: !!sender, forwardedByName: sender?.name ?? "", notified,
      matched: read.study ? (read.study.nickname || read.study.title) : "",
      basis: read.study ? read.basis : "",
      applied: applied.length, waiting: read.changes.length,
    });
  } catch (e) {
    console.error("ingest-email error", e);
    return json({ error: (e as Error).message ?? "Something went wrong" }, 500);
  }
});
