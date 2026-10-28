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
import { sendViaDomain } from "./warmup-mail.ts";
import { setStudies, setMatchHints, setMeetings, stripPHI as stripPHIRules, readEmail, applyChangeTo, PARSER_VERSION } from "./rules.ts";
import { looksLikeMeeting, studyContext, extractPrompt, callModel, applyMeeting, summaryEmail, threadRecipients, redactAll, tagVocabulary, MEETING_UNDO_HOURS } from "./meeting.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Set as an edge-function secret, and pasted into the Apps Script. Not a password anyone types.
const INGEST_SECRET = Deno.env.get("INGEST_SECRET") ?? "";
// Email ingest is offered to ONE lab. Adam, 9 Oct 2026: "don't do the auto update email option
// for other labs, it's not working well enough for that." So this isn't just a filter deciding
// which studies to search — it decides whether the forward is processed at all. A forward from
// another lab is refused and nothing is stored, rather than quietly half-working for a team that
// was never told the feature exists.
const INGEST_WORKSPACE = Deno.env.get("INGEST_WORKSPACE") ?? "sports-yanke";
// The labs it IS on for. Adam, 27 Oct 2026: turn it on for Singh's lab. A forward is filed in the
// SENDER'S lab — their studies, their roster, their team — never another lab's; a lab not listed
// here is still refused outright. Add a lab by adding it here (or the INGEST_WORKSPACES secret).
const INGEST_WORKSPACES = (Deno.env.get("INGEST_WORKSPACES") ?? "sports-yanke,spine-singh")
  .split(",").map((x) => x.trim()).filter(Boolean);
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://rushsportsresearch.netlify.app";
const SMTP_USER = Deno.env.get("SMTP_USER") ?? "";
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD") ?? "";
const SMTP_HOST = Deno.env.get("SMTP_HOST") ?? "smtp.gmail.com";
const SMTP_PORT = Number(Deno.env.get("SMTP_PORT") ?? "465");
const FROM_NAME = Deno.env.get("REMINDER_FROM_NAME") ?? "MOR Research Tracker";
// Shared mailboxes a whole team forwards from. These belong to no one profile, so without this a
// forward from the group address would be treated as a stranger and change nothing. Comma-separated
// in SHARED_INBOXES so more can be added without a deploy.
const SHARED_INBOXES = (Deno.env.get("SHARED_INBOXES") ?? "cartilage.restoration@rushortho.com")
  .split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
function sharedInboxName(addr: string): string {
  if (SHARED_INBOXES.indexOf(addr) < 0) return "";
  const local = addr.split("@")[0].replace(/[._-]+/g, " ").trim();
  return local.replace(/\b\w/g, (c) => c.toUpperCase()) + " (shared)";
}

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MEETING_MODEL = Deno.env.get("MEETING_MODEL") ?? "claude-sonnet-5-5";
// The tracker's own mailboxes: never a recipient of its own summaries.
// studyupdates@studypipeline.com (26 Oct 2026) is the address people forward to; Cloudflare Email
// Routing delivers it into the Gmail mailbox the Apps Script reads. Every address on the domain is
// the tracker's own, so none of them is ever a recipient — see threadRecipients' domain rule.
const TRACKER_MAILBOXES = (Deno.env.get("TRACKER_MAILBOXES") ?? "yankesportsresearch@gmail.com,studyupdates@studypipeline.com")
  .split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
// Links go to the address people actually use. SITE_URL predates the move to studypipeline.com.
const APP_URL = SITE_URL.includes("netlify.app") ? "https://studypipeline.com" : SITE_URL;

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendMail(opts: { to: string[]; cc?: string[]; subject: string; html: string; text: string;
                                inReplyTo?: string; references?: string }) {
  if (!opts.to.length) return false;
  // From studypipeline.com when that's switched on (warmup-mail.ts), still threaded under the
  // meeting email; replies go to the tracker's Gmail inbox. Gmail otherwise or on failure.
  if (await sendViaDomain({ kind: "meeting", fromName: FROM_NAME, to: opts.to, cc: opts.cc, subject: opts.subject,
        html: opts.html, text: opts.text, replyTo: SMTP_USER || undefined,
        inReplyTo: opts.inReplyTo, references: opts.references })) return true;
  if (!SMTP_USER || !SMTP_PASSWORD) return false;
  const smtp = new SMTPClient({
    connection: { hostname: SMTP_HOST, port: SMTP_PORT, tls: true, auth: { username: SMTP_USER, password: SMTP_PASSWORD } },
  });
  try {
    await smtp.send({
      from: `${FROM_NAME} <${SMTP_USER}>`, to: opts.to, cc: opts.cc && opts.cc.length ? opts.cc : undefined,
      subject: opts.subject, html: opts.html, content: opts.text,
      // Threading. With the original Message-ID in both headers, Gmail and Outlook file the summary
      // under the meeting email for everyone on it, instead of starting a new conversation.
      inReplyTo: opts.inReplyTo || undefined, references: opts.references || opts.inReplyTo || undefined,
    } as any);
    return true;
  } finally {
    try { await smtp.close(); } catch { /* already closed */ }
  }
}

// A forwarded meeting: read every action item, apply it, record it, reply on the thread.
// Runs after the response has gone back to Gmail — reading a long transcript takes longer than the
// Apps Script will wait — so everything it does is recorded on the meeting row, including failure.
async function processMeeting(db: any, rowId: string, sender: { id: string; name: string; notify: string; workspace?: string },
                              payload: any, subject: string, raw: string) {
  const nowIso = new Date().toISOString();
  const ws = sender.workspace || INGEST_WORKSPACE;
  const record: any = {
    id: rowId, createdAt: nowIso, source: "meeting", from: bareAddress(payload?.from ?? ""),
    subject, forwardedBy: sender.id, forwardedByName: sender.name, unverified: false,
    status: "applied", applied: [], notApplied: [], changes: [], needsParse: false, parserVersion: PARSER_VERSION,
    undoUntil: new Date(Date.now() + MEETING_UNDO_HOURS * 3600e3).toISOString(),
    sourceHash: payload.__hash, decidedAt: nowIso, decidedBy: "the tracker",
  };
  const save = async () => db.from("items").upsert({ id: rowId, kind: "suggestion", data: record,
    updated_at: new Date().toISOString(), workspace: ws });
  const replyTo = threadRecipients([payload?.from, payload?.to, payload?.cc].filter(Boolean),
    TRACKER_MAILBOXES.concat([SMTP_USER.toLowerCase()]));
  const reSubject = "Re: " + String(payload?.originalSubject || subject).replace(/^\s*(re|fw|fwd):\s*/i, "");
  try {
    const scrubbed = stripPHIRules(raw);
    const { data: studyRows } = await db.from("items").select("id, data").eq("kind", "study").eq("workspace", ws);
    const studies = (studyRows ?? []).map((r: any) => r.data).filter(Boolean);
    const { data: profRows } = await db.from("items").select("data").eq("kind", "profile").eq("workspace", ws);
    const profiles = (profRows ?? []).map((r: any) => r.data).filter((p: any) => p && p.name);
    const { data: metaRows } = await db.from("items").select("data").eq("kind", "meta").eq("workspace", ws);
    const rosterSet = new Set<string>();
    profiles.forEach((p: any) => rosterSet.add(String(p.name).trim()));
    (metaRows ?? []).forEach((r: any) => ((r.data && r.data.names) || []).forEach((n: any) => { if (typeof n === "string" && n.trim()) rosterSet.add(n.trim()); }));
    const roster = [...rosterSet];
    const tags = tagVocabulary((metaRows ?? []).map((r: any) => r.data && r.data.tagLists).filter(Boolean));

    const today = nowIso.slice(0, 10);
    const extracted = await callModel(ANTHROPIC_KEY, MEETING_MODEL,
      extractPrompt(scrubbed.text, studyContext(studies), roster, today, tags));
    const env = { uid: () => crypto.randomUUID(), today, by: sender.name, tags };
    const result = applyMeeting(extracted, studies, roster, env);

    // Writes, each checked. A change whose study failed to save is moved to "not applied" rather
    // than reported as done — the summary must never claim something that didn't happen.
    const failed = new Set<string>();
    for (const sid of result.touched) {
      const s = studies.find((x: any) => x.id === sid);
      const { error } = await db.from("items").update({ data: s, updated_at: new Date().toISOString() })
        .eq("id", sid).eq("workspace", ws);
      if (error) failed.add(sid);
    }
    for (const t of result.newTasks) {
      const { error } = await db.from("items").insert({ id: t.id, kind: "task", data: t, updated_at: new Date().toISOString(), workspace: ws });
      if (error) failed.add(t.id);
    }
    for (const s of result.newStudies) {
      const { error } = await db.from("items").insert({ id: s.id, kind: "study", data: s, updated_at: new Date().toISOString(), workspace: ws });
      if (error) failed.add(s.id);
    }
    record.applied = result.applied.filter((a: any) => !failed.has(a.studyId) && !(a.undo && failed.has(a.undo.taskId)));
    record.notApplied = result.notApplied.concat(result.applied
      .filter((a: any) => record.applied.indexOf(a) < 0)
      .map((a: any) => ({ text: a.label + ": " + a.to, why: "couldn't be saved — try again or enter it by hand", evidence: a.evidence })));
    record.studyIds = [...new Set(record.applied.map((a: any) => a.studyId))];
    // What is stored of the meeting itself: scrubbed of numbers by the rules AND of every patient
    // identifier the model found.
    record.text = redactAll(scrubbed.text, extracted.patientIdentifiers || []).slice(0, 20000);
    record.redacted = scrubbed.redacted + (extracted.patientIdentifiers || []).length;
    record.redactedKinds = scrubbed.kinds.concat((extracted.patientIdentifiers || []).length ? ["patient names"] : []);
  } catch (e) {
    record.status = "failed";
    record.error = (e as Error)?.message || String(e);
    record.text = stripPHIRules(raw).text.slice(0, 2000);
    console.error("meeting ingest failed", e);
  }

  // The PI's direct research team: the people who carry the changes out, whether or not they were
  // on the email (Adam, 26 Oct). lab_members rows with source = 'team' for this lab.
  let team: string[] = [];
  try {
    const { data: tm } = await db.from("lab_members").select("user_id").eq("workspace", ws).eq("source", "team");
    const ids = new Set((tm ?? []).map((r: any) => String(r.user_id)));
    const { data: pr } = await db.from("items").select("data").eq("kind", "profile");
    team = (pr ?? []).map((r: any) => r.data).filter((p: any) => p && ids.has(String(p.id)))
      .map((p: any) => String(p.alertEmail || p.email || "").trim().toLowerCase()).filter(Boolean);
  } catch (_) { /* the summary still goes to the thread */ }
  const to = replyTo.length ? replyTo : [sender.notify.toLowerCase()];
  const cc = team.filter((a) => to.indexOf(a) < 0 && TRACKER_MAILBOXES.indexOf(a) < 0);
  record.repliedTo = to; record.copied = cc;

  const link = `${APP_URL}/?update=${encodeURIComponent(rowId)}`;
  const mail = record.status === "failed"
    ? { html: `<p>The tracker couldn't read this meeting, so nothing was changed.</p><p style="color:#8e8e93">${record.error ? String(record.error).replace(/[<>&]/g, "") : ""}</p>`,
        text: "The tracker couldn't read this meeting, so nothing was changed. " + (record.error || "") }
    : summaryEmail({ applied: record.applied, notApplied: record.notApplied, undoUntil: record.undoUntil, link, subject, by: sender.name });
  try {
    record.replied = await sendMail({ to, cc, subject: reSubject, html: mail.html, text: mail.text,
      inReplyTo: payload?.messageId || "", references: payload?.references || payload?.messageId || "" });
  } catch (e) {
    record.replied = false; record.replyError = (e as Error)?.message || String(e);
  }
  await save();
}

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
  // Collapsed to a single line with no runs of spaces. Indented HTML leaves lines ending in a
  // space, which quoted-printable encodes as "=20" — and a mail client that doesn't decode it
  // renders a literal "=20" in the middle of the message. That showed up in the first real one.
  const wire = html.replace(/\s*\n\s*/g, "").replace(/ {2,}/g, " ");
  if (await sendViaDomain({ kind: "meeting", fromName: FROM_NAME, to, subject: matched ? `Read: ${matched}` : "Read your forwarded email",
        html: wire, replyTo: SMTP_USER || undefined })) return;
  const smtp = new SMTPClient({
    connection: { hostname: SMTP_HOST, port: SMTP_PORT, tls: true, auth: { username: SMTP_USER, password: SMTP_PASSWORD } },
  });
  try {
    await smtp.send({
      from: `${FROM_NAME} <${SMTP_USER}>`, to,
      subject: matched ? `Read: ${matched}` : "Read your forwarded email",
      html: wire, content: wire.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    } as any);
  } finally {
    try { await smtp.close(); } catch { /* already closed */ }
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-ingest-secret, apikey, x-client-info, x-supabase-api-version",
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
    // Profiles across every lab, because the sender has to be identified before we know which lab
    // they are in — but the lab comes back with them, and is checked immediately below.
    const { data: profileRows, error: profErr } = await db.from("items").select("data, workspace").eq("kind", "profile");
    if (profErr) throw profErr;
    let sender: { id: string; name: string; notify: string; workspace: string } | null = null;
    for (const row of profileRows ?? []) {
      const p = row.data as { id: string; name?: string; email?: string; alertEmail?: string; linkedTo?: string };
      if (!p?.id) continue;
      const addrs = [p.email, p.alertEmail].map(a => String(a ?? "").trim().toLowerCase()).filter(Boolean);
      if (addrs.indexOf(from) >= 0) {
        // Reply to the address they READ, which may not be the one they forwarded from.
        sender = { id: p.id, name: p.name ?? "", notify: (p.alertEmail || p.email || from).trim(),
                   workspace: String((row as any).workspace || "sports-yanke") };
        break;
      }
    }

    // Someone from a lab that doesn't have ingest. Refused outright: searching their studies would
    // mean reading a lab this feature was never turned on for, and searching the ingest lab's
    // studies would mean showing them someone else's work. Neither is acceptable, and there is no
    // third option that isn't a surprise to somebody.
    if (sender && INGEST_WORKSPACES.indexOf(sender.workspace) < 0) {
      console.warn(`ingest-email refused: ${from} is in ${sender.workspace}, ingest runs for ${INGEST_WORKSPACES.join(", ")}`);
      return json({ error: "Email forwarding isn't switched on for your team yet" }, 403);
    }

    if (!sender) {
      const groupName = sharedInboxName(from);
      // Replying to the group is the point: the person who forwarded it is reading that mailbox,
      // and a reply to an individual would reach the wrong one of them — or nobody.
      if (groupName) sender = { id: "", name: groupName, notify: from, workspace: INGEST_WORKSPACE };
    }
    // The lab this forward belongs to: the sender's own. Everything below reads and writes there.
    const ws = (sender && sender.workspace) || INGEST_WORKSPACE;

    // A MEETING — a transcript or meeting notes — goes to the meeting reader, which applies every
    // action item and replies on the thread. Only for a sender we know: a stranger's "meeting"
    // would be an open channel for editing studies. Without a model key it falls through to the
    // ordinary rules, which at worst file a note.
    if (sender && ANTHROPIC_KEY && looksLikeMeeting(subject, raw)) {
      const hash = await sha256(subject + "\n" + raw);
      // The Apps Script retries anything it didn't get a 200 for, and a long transcript can outlast
      // its patience. The same meeting must never be applied twice.
      const { data: dup } = await db.from("items").select("id").eq("kind", "suggestion")
        .eq("workspace", ws).eq("data->>sourceHash", hash).limit(1);
      if (dup && dup.length) return json({ ok: true, mode: "meeting", duplicate: true, id: dup[0].id });
      const rowId = crypto.randomUUID();
      const nowIso0 = new Date().toISOString();
      // A placeholder first, so a retry arriving while this one is still reading finds it.
      await db.from("items").insert({ id: rowId, kind: "suggestion", updated_at: nowIso0, workspace: ws,
        data: { id: rowId, createdAt: nowIso0, source: "meeting", status: "reading", subject, sourceHash: hash,
                forwardedBy: sender.id, forwardedByName: sender.name, applied: [], changes: [], needsParse: false,
                parserVersion: PARSER_VERSION } });
      const work = processMeeting(db, rowId, sender, Object.assign({}, payload, { __hash: hash }), subject, raw);
      const rt = (globalThis as any).EdgeRuntime;
      if (rt && typeof rt.waitUntil === "function") rt.waitUntil(work); else await work;
      return json({ ok: true, mode: "meeting", id: rowId, verified: true, forwardedByName: sender.name });
    }

    const clean = stripPHIRules(raw);
    const id = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    // Read it now, so a forward is fully understood within five minutes of being sent whether or
    // not anyone has the tracker open.
    const { data: studyRows, error: studyErr } = await db.from("items").select("id, data").eq("kind", "study").eq("workspace", ws);
    if (studyErr) throw studyErr;
    const studies = (studyRows ?? []).map((r: any) => r.data).filter(Boolean);
    setStudies(studies);
    // Corrections the team has made. Loaded here too, or a correction would only help whoever is
    // looking at the app and every forward would keep arriving mismatched.
    const { data: hintRows } = await db.from("items").select("data").eq("kind", "matchHint").eq("workspace", ws);
    setMatchHints((hintRows ?? []).map((r: any) => r.data).filter(Boolean));
    // The deadline catalogue, so an extension email can be matched to the meeting it is about.
    const { data: meetingRows } = await db.from("items").select("id, data").eq("kind", "meeting");
    const meetings = (meetingRows ?? []).map((r: any) => ({ ...r.data, id: r.id })).filter(Boolean);
    setMeetings(meetings);
    const read = readEmail(clean.text, subject);

    // Safe changes apply themselves — but never for a sender we couldn't place. Same rule as the
    // app: if we don't know who sent it, we don't act on it.
    const applied: any[] = [];
    if (sender && read.study && read.changes.some((c: any) => c.safe)) {
      const target = studies.find((s: any) => s.id === read.study.id);
      if (target) {
        // The same function the app uses, from the shared block — so an abstract submission or a
        // grant award lands in the same place whether it arrived by forward or by paste.
        const env = { uid: () => crypto.randomUUID(), today: () => new Date().toISOString().slice(0, 10) };
        read.changes.filter((c: any) => c.safe).forEach((c: any) => {
          applied.push(applyChangeTo(target, c, env));
        });
        read.changes = read.changes.filter((c: any) => !c.safe);
        const { error: upErr } = await db.from("items")
          .update({ data: target, updated_at: nowIso }).eq("id", target.id).eq("workspace", ws);
        // A failed write must not leave the suggestion claiming it applied something.
        if (upErr) { applied.length = 0; read.changes = readEmail(clean.text, subject).changes; }
      }
    }
    // A deadline extension changes the SHARED catalogue every lab sees, so it's handled here
    // rather than as a change on a study. Applied only when the date moves LATER — that direction
    // can only give people more time. Earlier is the dangerous direction and waits for a human,
    // as does anything from a sender we couldn't place.
    const extension: any = (read as any).extension || null;
    if (extension && sender && extension.later) {
      const target = meetings.find((m: any) => m.id === extension.meetingId);
      if (target) {
        const updated = {
          ...target,
          deadline: extension.to,
          dates: (target.dates ? target.dates + " " : "") +
            `Deadline extended to ${extension.to} (from a forwarded email, ${nowIso.slice(0, 10)}).`,
          // Newer than whatever the biweekly website refresh last wrote, or that refresh would put
          // the society's stale date straight back.
          verifiedOn: nowIso.slice(0, 16),
        };
        const { error: mErr } = await db.from("items")
          .update({ data: updated, updated_at: nowIso }).eq("id", target.id);
        if (!mErr) {
          applied.push({ field: "meetingDeadline", label: extension.meetingName + " deadline",
                         from: extension.from || "(none)", to: extension.to });
        }
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
      extension: extension || null,
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

    // The stamp. Without it the row lands with a NULL workspace, which no policy matches, and the
    // forward is captured into a queue nobody can see — a silent failure that looks exactly like
    // ingest not running at all.
    const { error: insErr } = await db.from("items").insert({
      id, kind: "suggestion", data: suggestion, updated_at: nowIso, workspace: ws,
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
