// Announcements: one note to everybody, sent from the app and recorded.   21 Oct 2026
//
// WHY THIS EXISTS: every announcement so far has been Adam pasting text into Gmail. That works
// until it doesn't — there is no record of what was said, no way to know who it reached, and the
// addresses have to be re-gathered by hand each time, which is how somebody gets left out. After
// a deploy that changes what people see, a note is part of the deploy, not an afterthought.
//
// Three actions:
//   preview  — who this would reach, and whether an identical note went out recently. Sends
//              nothing. The UI calls this as you type the audience, so the count is never a guess.
//   send     — the note itself. Returns what was delivered and what wasn't, per address.
//   history  — what has been sent before, newest first.
//
// WHO MAY SEND: an app admin can announce to every lab or to one. A LAB admin can announce to
// their own lab and nowhere else — the audience is clamped to their workspace on the server, not
// trusted from the request. Nobody else can send at all. This mirrors the rest of the app: see
// sees_whole_lab() in migration 011 for the same split.
//
// ADDRESSES ARE NEVER SHOWN TO EACH OTHER. One message per recipient, not one message with
// seventeen people in the To line. It also means a single bad address fails on its own instead of
// taking the batch down with it.
//
// PENDING INVITES ARE NOT INCLUDED, deliberately. Somebody who has been invited but has never
// signed in has no profile row, and a note about features they have not seen yet reads as spam
// from a service they have not used. They get the invite; they get the next announcement.
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
const REPLY_TO = Deno.env.get("REMINDER_REPLY_TO") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

// A plain-text note turned into something a mail client renders sensibly. Blank line is a
// paragraph, a line starting with "- " is a bullet. Nothing cleverer: the person writing it is a
// surgeon between cases, not somebody who wants to learn a markup language.
function bodyToHtml(body: string): string {
  const blocks = String(body || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  return blocks.map((block) => {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) return "";
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      return `<ul style="margin:0 0 14px 0;padding-left:22px">` +
        lines.map((l) => `<li style="margin:0 0 6px 0">${esc(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("") +
        `</ul>`;
    }
    return `<p style="margin:0 0 14px 0">${lines.map((l) => esc(l)).join("<br>")}</p>`;
  }).join("");
}

function wrap(subject: string, body: string, fromName: string): string {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1b1b1f;max-width:560px">
    <h2 style="font-size:18px;margin:0 0 16px 0">${esc(subject)}</h2>
    ${bodyToHtml(body)}
    <p style="margin:22px 0 0 0"><a href="${esc(SITE_URL)}" style="color:#2563eb;font-weight:700;text-decoration:none">Open the tracker →</a></p>
    <p style="margin:18px 0 0 0;font-size:12px;color:#6b7280">Sent by ${esc(fromName)} through the MOR Research Tracker.
      If the site loads but won't sign you in, that's usually your network blocking it — a phone hotspot gets you in.</p>
  </div>`;
}

const addressOf = (d: Record<string, unknown>): string =>
  String((d && (d.alertEmail as string)) || (d && (d.email as string)) || "").trim().toLowerCase();

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
    const callerEmail = String(who.user.email).toLowerCase();

    // Who the caller is, read from the database rather than from anything the client said.
    const { data: callerProfile } = await db.from("items")
      .select("workspace, data").eq("kind", "profile").eq("id", callerId).maybeSingle();
    const callerWorkspace = String((callerProfile as any)?.workspace || "");
    const callerName = String(((callerProfile as any)?.data || {}).name || who.user.email);
    const isLabAdmin = !!(((callerProfile as any)?.data || {}).admin);

    const { data: adminRow } = await db.from("app_admins")
      .select("user_id").eq("user_id", callerId).maybeSingle();
    const isAppAdmin = !!adminRow;

    if (!isAppAdmin && !isLabAdmin) return json({ error: "Only admins can send announcements" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "preview");

    if (action === "history") {
      // An app admin sees every announcement; a lab admin sees their own lab's. Same rule as
      // everything else, so the audit trail doesn't become the leak.
      let q = db.from("items").select("id, data, updated_at, workspace").eq("kind", "announcement");
      if (!isAppAdmin) q = q.eq("workspace", callerWorkspace);
      const { data: rows, error } = await q.order("updated_at", { ascending: false }).limit(25);
      if (error) throw error;
      return json({ ok: true, history: (rows ?? []).map((r: any) => ({
        id: r.id, workspace: r.workspace, sentAt: r.data?.sentAt || r.updated_at,
        subject: r.data?.subject || "", by: r.data?.by || "", audience: r.data?.audience || "",
        delivered: (r.data?.recipients || []).length, failed: (r.data?.failed || []).length,
      })) });
    }

    // THE AUDIENCE IS CLAMPED HERE. A lab admin asking for "all" gets their own lab, whatever the
    // request said — the client is not the thing that decides who a message reaches.
    const requested = String(body?.audience ?? "all").trim();
    const audience = isAppAdmin ? (requested || "all") : callerWorkspace;
    if (!isAppAdmin && requested && requested !== callerWorkspace && requested !== "all") {
      return json({ error: "You can only announce to your own lab" }, 403);
    }

    // Profiles carry the addresses. Read with the workspace column and grouped in code, because
    // the service role bypasses RLS and "all labs" is a legitimate audience for an app admin —
    // see tests/test_edge_functions_workspace_scoped.js, where this read is a listed exception.
    const { data: profs, error: profErr } = await db.from("items")
      .select("id, data, workspace").eq("kind", "profile");
    if (profErr) throw profErr;

    const seen = new Set<string>();
    const recipients: { email: string; name: string; workspace: string }[] = [];
    for (const r of (profs ?? []) as any[]) {
      const ws = String(r.workspace || "");
      if (audience !== "all" && ws !== audience) continue;
      const email = addressOf(r.data || {});
      if (!email || !email.includes("@")) continue;
      // One person can hold two accounts (see the account-linking work). Both would carry the same
      // alert address, and nobody wants the same note twice.
      if (seen.has(email)) continue;
      seen.add(email);
      recipients.push({ email, name: String((r.data || {}).name || ""), workspace: ws });
    }

    const subject = String(body?.subject ?? "").trim();
    const text = String(body?.body ?? "").trim();

    // Was this already sent? Compared on subject AND body, because a resend is nearly always an
    // accidental double-click or a retry after a timeout that actually worked.
    const { data: recent } = await db.from("items")
      .select("id, data, updated_at").eq("kind", "announcement")
      .order("updated_at", { ascending: false }).limit(10);
    const dupe = (recent ?? []).find((r: any) =>
      String(r.data?.subject || "").trim() === subject &&
      String(r.data?.body || "").trim() === text &&
      subject && Date.now() - new Date(r.data?.sentAt || r.updated_at).getTime() < 60 * 60 * 1000);

    if (action === "preview") {
      return json({
        ok: true, audience, count: recipients.length,
        labs: [...new Set(recipients.map((r) => r.workspace))].sort(),
        sample: recipients.slice(0, 5).map((r) => r.email),
        alreadySent: dupe ? { sentAt: dupe.data?.sentAt || dupe.updated_at, by: dupe.data?.by || "" } : null,
        canSendToAllLabs: isAppAdmin,
      });
    }

    if (action !== "send") return json({ error: `Unknown action "${action}"` }, 400);
    if (!subject) return json({ error: "Give it a subject — it's the only part some people read" }, 400);
    if (!text) return json({ error: "The note is empty" }, 400);
    if (!recipients.length) return json({ error: "Nobody to send to — nobody in that audience has an address yet" }, 400);
    if (dupe && body?.confirm !== true) {
      return json({
        error: "already-sent",
        alreadySent: { sentAt: dupe.data?.sentAt || dupe.updated_at, by: dupe.data?.by || "" },
        message: "That exact note went out within the last hour. Send it again?",
      }, 409);
    }

    const html = wrap(subject, text, callerName);
    const plain = String(text);
    const smtp = new SMTPClient({
      connection: { hostname: SMTP_HOST, port: SMTP_PORT, tls: true, auth: { username: SMTP_USER, password: SMTP_PASSWORD } },
    });
    const delivered: string[] = [];
    const failed: { email: string; why: string }[] = [];
    try {
      for (const r of recipients) {
        try {
          await smtp.send({
            from: `${FROM_NAME} <${SMTP_USER}>`,
            to: r.email,
            replyTo: REPLY_TO || undefined,
            subject,
            // One line, single spaces — otherwise Gmail's SMTP path shows "=20" in some clients.
            html: html.replace(/\s*\n\s*/g, " ").replace(/ {2,}/g, " "),
            content: plain,
          } as any);
          delivered.push(r.email);
        } catch (e) {
          // One address failing must not stop the other sixteen. Recorded per address so a
          // bounce can be chased rather than guessed at.
          failed.push({ email: r.email, why: String((e as Error)?.message || e).slice(0, 200) });
        }
      }
    } finally {
      try { await smtp.close(); } catch { /* already closed */ }
    }

    const id = crypto.randomUUID();
    const sentAt = new Date().toISOString();
    // Recorded even when every address failed: "we tried and it all bounced" is exactly the thing
    // somebody needs to be able to look up later.
    const { error: logErr } = await db.from("items").insert({
      id, kind: "announcement", updated_at: sentAt,
      workspace: audience === "all" ? (callerWorkspace || "sports-yanke") : audience,
      data: { id, subject, body: text, audience, sentAt, by: callerName, byEmail: callerEmail,
              recipients: delivered, failed },
    });
    if (logErr) console.warn("announcement sent but not logged", logErr);

    return json({
      ok: true, id, audience, sent: delivered.length, failed,
      logged: !logErr,
      message: failed.length
        ? `Sent to ${delivered.length} of ${delivered.length + failed.length} — ${failed.length} failed`
        : `Sent to ${delivered.length} ${delivered.length === 1 ? "person" : "people"}`,
    });
  } catch (e) {
    console.error("announce failed", e);
    return json({ error: (e as Error)?.message || "announce failed" }, 500);
  }
});
