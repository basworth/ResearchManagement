// Emails Adam when somebody reports a problem or suggests a change.
//
// Until now "Suggest a change" wrote a row into the `feedback` table and said thank you. Nothing
// read that table. For his own team that was survivable — they'd mention it in the corridor. A
// second lab has no corridor: a report that goes nowhere looks exactly like a report that was
// ignored, and the second time it happens people stop reporting.
//
// The row is written by the app FIRST and this is called after. That order is deliberate: if the
// mail fails, the report still exists and can be found. If this were the only path, an SMTP
// hiccup would lose somebody's bug report silently — the failure mode that made this necessary in
// the first place.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://studypipeline.com";
const SMTP_USER = Deno.env.get("SMTP_USER") ?? "";
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD") ?? "";
const SMTP_HOST = Deno.env.get("SMTP_HOST") ?? "smtp.gmail.com";
const SMTP_PORT = Number(Deno.env.get("SMTP_PORT") ?? "465");
const FROM_NAME = Deno.env.get("REMINDER_FROM_NAME") ?? "MOR Research Tracker";
const TO = Deno.env.get("FEEDBACK_TO") ?? "adam.yanke@rushortho.com";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" };
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  let smtp: SMTPClient | null = null;
  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Not signed in" }, 401);

    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: who, error: whoErr } = await db.auth.getUser(token);
    if (whoErr || !who?.user?.id) return json({ error: "Could not verify who you are" }, 401);
    const callerId = who.user.id;

    const body = await req.json().catch(() => ({}));
    const id = String(body?.id ?? "").trim();
    if (!id) return json({ error: "No report given" }, 400);

    // Read the stored row rather than trusting the request body: what gets emailed is then
    // exactly what was recorded, and a caller can't put words in someone else's mouth.
    const { data: row } = await db.from("feedback").select("*").eq("id", id).maybeSingle();
    if (!row) return json({ error: "That report no longer exists" }, 404);
    // You may only send the alert for your own report. Without this, any signed-in account could
    // walk the ids and have the tracker read other people's reports out to Adam by email.
    if (String(row.author_id ?? "") !== callerId) return json({ error: "That isn't your report" }, 403);

    const isProblem = String(row.kind ?? "") === "problem";
    const name = String(row.author_name ?? "") || String(row.author_email ?? "") || "Someone";
    const subject = (isProblem ? "Problem reported: " : "Idea from ") + name;

    smtp = new SMTPClient({
      connection: { hostname: SMTP_HOST, port: SMTP_PORT, tls: true, auth: { username: SMTP_USER, password: SMTP_PASSWORD } },
    });
    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px">
        <div style="font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:#8e8e93;font-weight:700">
          ${isProblem ? "Problem reported" : "Idea"}
        </div>
        <h1 style="font-size:19px;margin:6px 0 14px 0">${esc(name)}</h1>
        <div style="border:1px solid #e5e5ea;border-radius:11px;padding:14px 16px;font-size:14.5px;line-height:1.6;white-space:pre-wrap">${esc(row.body)}</div>
        <table style="border-collapse:collapse;margin:16px 0;font-size:13px;color:#3a3a3c">
          <tr><td style="padding:3px 14px 3px 0;color:#8e8e93">Who</td><td>${esc(name)}</td></tr>
          <tr><td style="padding:3px 14px 3px 0;color:#8e8e93">Reply to</td><td>${esc(row.author_email ?? "")}</td></tr>
          <tr><td style="padding:3px 14px 3px 0;color:#8e8e93">Lab</td><td>${esc(row.workspace ?? "")}</td></tr>
          <tr><td style="padding:3px 14px 3px 0;color:#8e8e93">Screen</td><td>${esc(row.page ?? "") || "—"}</td></tr>
        </table>
        <p style="margin:18px 0 0 0"><a href="${SITE_URL}" style="background:#0a84ff;color:#fff;text-decoration:none;font-weight:600;font-size:14.5px;padding:10px 18px;border-radius:9px;display:inline-block">Open the tracker</a></p>
        <p style="font-size:11.5px;color:#8e8e93;line-height:1.45;margin-top:20px">
          Sent because someone used ${isProblem ? '"Something\'s wrong"' : '"Suggest a change"'} in the tracker.
          Reply to this message and it goes straight back to them.
        </p>
      </div>`;
    const msg: Record<string, unknown> = {
      from: `${FROM_NAME} <${SMTP_USER}>`, to: TO, subject, html,
      content: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    };
    // So hitting Reply reaches the person who reported it, not a mailbox nobody reads.
    if (row.author_email) msg.replyTo = String(row.author_email);
    await smtp.send(msg as never);

    console.log(`feedback-alert sent for ${id} (${row.kind}) from ${row.author_email}`);
    return json({ ok: true });
  } catch (e) {
    console.error("feedback-alert failed:", e);
    return json({ error: (e as Error)?.message || "failed" }, 500);
  } finally {
    if (smtp) { try { await smtp.close(); } catch { /* already closed */ } }
  }
});
