// Sending from studypipeline.com — the warm-up (28 Oct 2026).
//
// Every tracker email used to leave from a personal Gmail account. Rush's mail security treats an
// outside Gmail address as suspect, MOR IT won't allowlist anything, and the lasting fix is mail
// from our own domain. A domain only earns a reputation by sending, and in September a brand-new
// one sending sign-in codes was quarantined outright — so it starts with the LOW-STAKES mail only
// (task reminders, stalled-study alerts, meeting summaries). Sign-in codes stay on Gmail (they go
// through Supabase Auth, not through here) until this has a few weeks of clean delivery behind it.
//
// Fails safe: no key, a kind not switched on, or Resend refusing → returns false and the caller
// sends through Gmail exactly as before. Nothing is lost by turning this on.
//
// Secrets: RESEND_API_KEY (Adam pastes it; never in code), RESEND_FROM (default
// updates@mail.studypipeline.com, the domain verified in Resend), RESEND_KINDS (default
// "task,stage,meeting"; set it to "none" to put everything back on Gmail — takes effect when the
// function is next redeployed).
//
// This file is copied, byte for byte, into each function that sends mail (Supabase deploys each
// function on its own). tests/test_warmup_mail.js checks the copies stay identical.

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? "updates@mail.studypipeline.com";
const RESEND_KINDS = (Deno.env.get("RESEND_KINDS") ?? "task,stage,meeting")
  .split(",").map((k) => k.trim()).filter(Boolean);

export type WarmupMail = {
  kind: "task" | "stage" | "meeting";
  fromName: string;
  to: string | string[];
  cc?: string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
};

export async function sendViaDomain(m: WarmupMail): Promise<boolean> {
  if (!RESEND_API_KEY || !RESEND_KINDS.includes(m.kind)) return false;
  const headers: Record<string, string> = {};
  if (m.inReplyTo) headers["In-Reply-To"] = m.inReplyTo;
  if (m.references || m.inReplyTo) headers["References"] = (m.references || m.inReplyTo) as string;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${m.fromName} <${RESEND_FROM}>`,
        to: Array.isArray(m.to) ? m.to : [m.to],
        cc: m.cc && m.cc.length ? m.cc : undefined,
        subject: m.subject,
        html: m.html,
        text: m.text || m.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        reply_to: m.replyTo || undefined,
        headers: Object.keys(headers).length ? headers : undefined,
      }),
    });
    if (!r.ok) {
      console.warn(`domain send refused (${r.status}), falling back to Gmail:`, (await r.text()).slice(0, 300));
      return false;
    }
    console.log(`sent via ${RESEND_FROM}: ${m.kind} → ${Array.isArray(m.to) ? m.to.join(", ") : m.to}`);
    return true;
  } catch (e) {
    console.warn("domain send failed, falling back to Gmail:", e);
    return false;
  }
}
