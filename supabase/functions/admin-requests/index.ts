// Admin access requests: ask, and be approved by Adam alone.
//
// Why this is a server function rather than app code: the database now refuses to let ANY
// client move a profile's admin flag (see admin-requests-setup.sql). Only the service role can,
// and it lives here. So "requests only, Adam gates it" is enforced rather than merely displayed.
//
// Two actions:
//   request  — any signed-in user asks for admin. Emails the approver.
//   decide   — approve or deny. Caller must be the approver; checked against their verified
//              token identity, not anything the client claims.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APPROVER = (Deno.env.get("ADMIN_APPROVER") ?? "adam.yanke@rushortho.com").toLowerCase();
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://studypipeline.com";
const SMTP_USER = Deno.env.get("SMTP_USER")!;
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD")!;
const SMTP_HOST = Deno.env.get("SMTP_HOST") ?? "smtp.gmail.com";
const SMTP_PORT = Number(Deno.env.get("SMTP_PORT") ?? "465");
const FROM_NAME = Deno.env.get("REMINDER_FROM_NAME") ?? "MOR Research Tracker";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

async function sendMail(to: string, subject: string, html: string) {
  const smtp = new SMTPClient({
    connection: { hostname: SMTP_HOST, port: SMTP_PORT, tls: true, auth: { username: SMTP_USER, password: SMTP_PASSWORD } },
  });
  try {
    await smtp.send({
      from: `${FROM_NAME} <${SMTP_USER}>`,
      to, subject, html,
      content: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    } as any);
  } finally {
    try { await smtp.close(); } catch { /* already closed */ }
  }
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
    const callerEmail = who.user.email.toLowerCase();

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "");

    // ---------- ask ----------
    if (action === "request") {
      const { data: adminRow } = await db.from("app_admins").select("user_id").eq("user_id", callerId).maybeSingle();
      if (adminRow) return json({ ok: false, message: "You're already an admin." });

      const reason = String(body?.reason ?? "").slice(0, 500);
      const { error: insErr } = await db.from("admin_requests")
        .insert({ user_id: callerId, reason, status: "pending" });
      if (insErr) {
        // The partial unique index allows only one open request per person.
        if ((insErr as any).code === "23505") return json({ ok: false, message: "You already have a request waiting for a decision." });
        throw insErr;
      }

      const { data: prof } = await db.from("items").select("data").eq("kind", "profile").eq("id", callerId).maybeSingle();
      const name = (prof?.data as any)?.name || callerEmail;
      await sendMail(APPROVER, `Admin access requested by ${name}`, `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px">
          <h2 style="font-size:17px;margin:0 0 10px">Admin access requested</h2>
          <p style="font-size:14px;color:#3a3a3c;line-height:1.5">
            <b>${esc(name)}</b> (${esc(callerEmail)}) has asked for admin rights on the Research Tracker.
          </p>
          ${reason ? `<p style="font-size:13.5px;color:#3a3a3c;background:#f2f2f7;border-radius:9px;padding:11px 13px">${esc(reason)}</p>` : ""}
          <p style="font-size:14px;color:#3a3a3c;line-height:1.5">
            Approve or decline it in <a href="${SITE_URL}">Settings &rsaquo; Admin Requests</a>. Nothing changes until you do.
          </p>
          <p style="font-size:11.5px;color:#8e8e93;line-height:1.45;margin-top:18px">
            Only you can approve admin requests. Admin rights can't be granted any other way.
          </p>
        </div>`);
      console.log(`admin request from ${callerEmail}`);
      return json({ ok: true, message: "Request sent to Adam for approval." });
    }

    // ---------- decide ----------
    if (action === "decide") {
      if (callerEmail !== APPROVER) return json({ error: "Only Adam can approve admin requests" }, 403);
      const requestId = String(body?.requestId ?? "");
      const approve = body?.approve === true;
      if (!requestId) return json({ error: "Which request?" }, 400);

      const { data: reqRow, error: reqErr } = await db.from("admin_requests").select("*").eq("id", requestId).maybeSingle();
      if (reqErr) throw reqErr;
      if (!reqRow) return json({ error: "That request no longer exists" }, 404);
      if (reqRow.status !== "pending") return json({ ok: false, message: `That request was already ${reqRow.status}.` });

      const { error: updErr } = await db.from("admin_requests")
        .update({ status: approve ? "approved" : "denied", decided_at: new Date().toISOString(), decided_by: callerId })
        .eq("id", requestId).eq("status", "pending");
      if (updErr) throw updErr;

      if (approve) {
        // Service role, so the profile guard permits the flag — and its trigger adds the row to
        // app_admins, keeping one source of truth.
        const { data: prof } = await db.from("items").select("data").eq("kind", "profile").eq("id", reqRow.user_id).maybeSingle();
        if (!prof) return json({ error: "They have no profile yet — ask them to sign in once first" }, 409);
        const next = { ...(prof.data as any), admin: true };
        const { error: setErr } = await db.from("items")
          .update({ data: next, updated_at: new Date().toISOString() })
          .eq("kind", "profile").eq("id", reqRow.user_id);
        if (setErr) throw setErr;
      }

      const { data: target } = await db.auth.admin.getUserById(reqRow.user_id);
      const targetEmail = target?.user?.email;
      if (targetEmail) {
        await sendMail(targetEmail,
          approve ? "You now have admin access" : "Admin access request declined",
          `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px">
             <p style="font-size:14px;color:#3a3a3c;line-height:1.5">${approve
               ? `Your request for admin access on the Research Tracker was approved. Reload the app and you'll see every project.`
               : `Your request for admin access on the Research Tracker was declined. Nothing about your account has changed.`}</p>
           </div>`).catch((e) => console.error("notify failed", e));
      }
      console.log(`admin request ${requestId} ${approve ? "approved" : "denied"} by ${callerEmail}`);
      return json({ ok: true, message: approve ? "Approved — they're now an admin." : "Request declined." });
    }

    // ---------- set (approver grants or revokes directly) ----------
    // Adam shouldn't have to ask himself for permission. He can flip the flag straight from the
    // org chart; everyone else still has to request it and wait, because this branch refuses any
    // caller who isn't the approver — checked against their verified token, not a client claim.
    if (action === "set") {
      if (callerEmail !== APPROVER) {
        return json({ error: "Only Adam can grant admin rights. Use \"Request admin access\" instead." }, 403);
      }
      const userId = String(body?.userId ?? "");
      const makeAdmin = body?.admin === true;
      if (!userId) return json({ error: "Which person?" }, 400);
      // Refusing self-revocation isn't paranoia: the approver is the only route back in, so
      // removing his own flag would leave nobody able to restore it.
      if (userId === callerId && !makeAdmin) {
        return json({ error: "You can't remove your own admin rights — there'd be no way to grant them back." }, 400);
      }

      const { data: prof } = await db.from("items").select("data").eq("kind", "profile").eq("id", userId).maybeSingle();
      if (!prof) return json({ error: "They have no profile yet — ask them to sign in once first" }, 409);
      const already = ((prof.data as Record<string, unknown>)?.admin === true);
      if (already === makeAdmin) {
        return json({ ok: true, message: makeAdmin ? "They were already an admin." : "They already weren't an admin." });
      }

      // Service role, so the profile guard permits the flag — and its trigger keeps app_admins
      // in step, so there's still one source of truth.
      const next = { ...(prof.data as Record<string, unknown>), admin: makeAdmin };
      const { error: setErr } = await db.from("items")
        .update({ data: next, updated_at: new Date().toISOString() })
        .eq("kind", "profile").eq("id", userId);
      if (setErr) throw setErr;

      // Close any request they had open, so an approved-by-hand grant doesn't leave a stale
      // "waiting for a decision" row that blocks them from ever asking again.
      await db.from("admin_requests")
        .update({ status: makeAdmin ? "approved" : "denied", decided_at: new Date().toISOString(), decided_by: callerId })
        .eq("user_id", userId).eq("status", "pending");

      const { data: target } = await db.auth.admin.getUserById(userId);
      const targetEmail = target?.user?.email;
      const targetName = ((prof.data as Record<string, unknown>)?.name as string) || targetEmail || "they";
      if (targetEmail) {
        await sendMail(targetEmail,
          makeAdmin ? "You now have admin access" : "Your admin access was removed",
          `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px">
             <p style="font-size:14px;color:#3a3a3c;line-height:1.5">${makeAdmin
               ? "You've been given admin access on the Research Tracker. Reload the app and you'll see every project."
               : "Your admin access on the Research Tracker was removed. Your account and your own projects are unchanged."}</p>
           </div>`).catch((e) => console.error("notify failed", e));
      }
      console.log(`admin ${makeAdmin ? "granted to" : "revoked from"} ${targetEmail} by ${callerEmail}`);
      return json({ ok: true, admin: makeAdmin,
        message: makeAdmin ? `${targetName} is now an admin.` : `${targetName} is no longer an admin.` });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("admin-requests failed:", e);
    return json({ error: (e as Error)?.message || "Something went wrong" }, 500);
  }
});
