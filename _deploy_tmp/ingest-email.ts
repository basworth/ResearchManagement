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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Set as an edge-function secret, and pasted into the Apps Script. Not a password anyone types.
const INGEST_SECRET = Deno.env.get("INGEST_SECRET") ?? "";

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

// Kept in step with stripPHI() in the app. Applied HERE as well as there, because this is the
// point where the text first touches the database — scrubbing only on display would mean storing
// the unscrubbed original.
const PHI_PATTERNS: Array<[RegExp, string]> = [
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn removed]"],
  [/\bMRN[:# ]*\d{4,12}\b/gi, "[mrn removed]"],
  [/\b(?:medical record(?: number)?|patient id)[:# ]*\d{4,12}\b/gi, "[mrn removed]"],
  [/\b\d{7,12}\b/g, "[number removed]"],
  [/\b(?:dob|date of birth)[:\s]*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/gi, "[dob removed]"],
  [/\b\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g, "[phone removed]"],
];
function stripPHI(text: string): { text: string; redacted: number; kinds: string[] } {
  let out = String(text ?? "");
  const found: string[] = [];
  for (const [re, as] of PHI_PATTERNS) {
    out = out.replace(re, () => { found.push(as); return as; });
  }
  return { text: out, redacted: found.length, kinds: [...new Set(found)] };
}

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
    let sender: { id: string; name: string } | null = null;
    for (const row of profileRows ?? []) {
      const p = row.data as { id: string; name?: string; email?: string; alertEmail?: string; linkedTo?: string };
      if (!p?.id) continue;
      const addrs = [p.email, p.alertEmail].map(a => String(a ?? "").trim().toLowerCase()).filter(Boolean);
      if (addrs.indexOf(from) >= 0) { sender = { id: p.id, name: p.name ?? "" }; break; }
    }

    const clean = stripPHI(raw);
    const id = crypto.randomUUID();
    const nowIso = new Date().toISOString();
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
      // Deliberately empty: the app matches the study and works out the changes when it loads this,
      // using the same code that handles a pasted email. One set of rules, one place.
      studyId: "",
      basis: "",
      changes: [],
      applied: [],
      status: "pending",
      needsParse: true,
    };

    const { error: insErr } = await db.from("items").insert({
      id, kind: "suggestion", data: suggestion, updated_at: nowIso,
    });
    if (insErr) throw insErr;

    return json({ ok: true, id, verified: !!sender, forwardedByName: sender?.name ?? "" });
  } catch (e) {
    console.error("ingest-email error", e);
    return json({ error: (e as Error).message ?? "Something went wrong" }, 500);
  }
});
