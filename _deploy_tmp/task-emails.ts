// Task reminder emails for the MOR Research Tracker.
//
// Runs on Supabase Edge Functions (Deno). Two jobs in one function:
//
//   1. ASSIGNMENT — fired instantly by a database webhook when a task row is inserted or
//      updated. Emails anyone newly added to the task's assignee list.
//   2. SWEEP — fired on a schedule (pg_cron). Emails people about tasks that are due soon
//      or already overdue.
//
// Every send is recorded in the `email_log` table, which has a unique constraint on
// (task_id, recipient, kind). That's what stops the sweep re-sending the same "due soon"
// nudge every time it runs — the insert simply conflicts and we skip the email.
//
// Nothing here touches patient data: the tracker is study-level only, so emails contain a
// task title, a study nickname, and a due date.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Gmail SMTP rather than a transactional API: Rush IT won't add DNS records for rushortho.com,
// and providers like Resend require domain verification before they'll send to anyone but the
// account owner. Authenticating as a real mailbox sidesteps that entirely — recipients can be
// any address, including @rushortho.com.
const SMTP_USER = Deno.env.get("SMTP_USER")!;              // e.g. yankelabresearch@gmail.com
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD")!;      // Google *app password*, not the login password
const SMTP_HOST = Deno.env.get("SMTP_HOST") ?? "smtp.gmail.com";
const SMTP_PORT = Number(Deno.env.get("SMTP_PORT") ?? "465");
const FROM_NAME = Deno.env.get("REMINDER_FROM_NAME") ?? "MOR Research Tracker";
const APP_URL = Deno.env.get("APP_URL") ?? "https://rushsportsresearch.netlify.app";
// How many days ahead counts as "due soon".
const DUE_SOON_DAYS = Number(Deno.env.get("DUE_SOON_DAYS") ?? "3");

const db = createClient(SUPABASE_URL, SERVICE_KEY);

// The app stores names, not emails. Profiles (written when someone first signs in and picks
// their name) are the bridge from a task assignee to a real address.
type Profile = { id: string; email: string; name: string };

// Mirrors the alias map in the app: the same person has been spelled several ways over the
// years, so a task assigned to "Zach O" must still reach Zachary Oppenheim.
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

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysUntil(dateStr: string): number {
  const d = new Date(dateStr + "T00:00:00Z").getTime();
  const t = new Date(todayISO() + "T00:00:00Z").getTime();
  return Math.round((d - t) / 86400000);
}
function fmtDate(dateStr: string): string {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US",
    { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// Everything downstream reads `profile.email` as "where to write to them", so the substitution
// happens here, once. Two reasons it isn't just the sign-in address:
//
//   alertEmail — Rush hands out both a rush.edu and a rushortho.com address and people read one
//                of them, so the address someone was invited at doesn't reliably reach them.
//   linkedTo   — one person with two accounts shares a display name across both, so without
//                skipping the spare it would overwrite the primary in this map and the reminder
//                would go to whichever row loaded last.
async function loadProfiles(): Promise<Map<string, Profile>> {
  const { data, error } = await db.from("items").select("data").eq("kind", "profile");
  if (error) throw error;
  const byName = new Map<string, Profile>();
  for (const row of data ?? []) {
    const p = row.data as Profile & { alertEmail?: string; linkedTo?: string };
    if (!p?.email || !p?.name) continue;
    if (p.linkedTo) continue;
    const to = (p.alertEmail || "").trim() || p.email;
    byName.set(canonName(p.name).toLowerCase(), { ...p, email: to });
  }
  return byName;
}

async function loadStudies(): Promise<Map<string, any>> {
  const { data, error } = await db.from("items").select("data").eq("kind", "study");
  if (error) throw error;
  const byId = new Map<string, any>();
  for (const row of data ?? []) byId.set((row.data as any).id, row.data);
  return byId;
}

function studyLabel(studies: Map<string, any>, studyId: string): string {
  const s = studies.get(studyId);
  if (!s) return "";
  return s.nickname || s.title || "";
}

// Returns false when this exact reminder already went out, so callers can skip the send.
// NOTE: claiming happens BEFORE the send (to avoid two concurrent runs double-emailing), so
// every caller must releaseClaims() if the send then fails — otherwise a transient SMTP
// outage would permanently suppress that reminder.
async function claim(taskId: string, recipient: string, kind: string): Promise<boolean> {
  const { error } = await db.from("email_log").insert({ task_id: taskId, recipient, kind });
  if (!error) return true;
  // 23505 = unique violation, i.e. already sent. Anything else is a real problem.
  if ((error as any).code === "23505") return false;
  throw error;
}
type Claim = { taskId: string; recipient: string; kind: string };
async function releaseClaims(claims: Claim[]): Promise<void> {
  for (const c of claims) {
    await db.from("email_log").delete()
      .eq("task_id", c.taskId).eq("recipient", c.recipient).eq("kind", c.kind);
  }
}

// One SMTP connection is opened per function invocation and reused for every message, then
// closed in a finally block — Gmail throttles hard if you reconnect for each email.
let smtp: SMTPClient | null = null;
async function smtpClient(): Promise<SMTPClient> {
  if (smtp) return smtp;
  smtp = new SMTPClient({
    connection: {
      hostname: SMTP_HOST,
      port: SMTP_PORT,
      tls: SMTP_PORT === 465, // 465 = implicit TLS; 587 would be STARTTLS
      auth: { username: SMTP_USER, password: SMTP_PASSWORD },
    },
  });
  return smtp;
}
async function closeSmtp(): Promise<void> {
  if (!smtp) return;
  try { await smtp.close(); } catch (_) { /* already closed */ }
  smtp = null;
}
async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const client = await smtpClient();
  await client.send({
    from: `${FROM_NAME} <${SMTP_USER}>`,
    to,
    subject,
    html,
    // Plain-text fallback so the message isn't flagged as HTML-only (a spam signal).
    content: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  });
}

function shell(heading: string, intro: string, rows: string, footer = ""): string {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1c1c1e">
    <div style="font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:#8e8e93;font-weight:700">Midwest Orthopaedics at Rush</div>
    <h1 style="font-size:19px;margin:6px 0 14px 0">${heading}</h1>
    <p style="font-size:14.5px;line-height:1.5;color:#3a3a3c;margin:0 0 16px 0">${intro}</p>
    ${rows}
    <p style="margin:22px 0 0 0"><a href="${APP_URL}" style="background:#0a84ff;color:#fff;text-decoration:none;font-weight:600;font-size:14.5px;padding:10px 18px;border-radius:9px;display:inline-block">Open Research Tracker</a></p>
    ${footer}
    <p style="font-size:11.5px;color:#8e8e93;line-height:1.45;margin-top:20px">You're getting this because you're assigned to this work in the Research Tracker.</p>
  </div>`;
}

function taskRow(title: string, study: string, due: string, note: string): string {
  return `<div style="border:1px solid #e5e5ea;border-radius:11px;padding:13px 15px;margin-bottom:9px">
    <div style="font-size:15px;font-weight:600">${esc(title)}</div>
    <div style="font-size:12.5px;color:#8e8e93;margin-top:3px">
      ${study ? esc(study) + " · " : ""}${due ? "Due " + esc(fmtDate(due)) : "No due date"}${note ? ` · <span style="color:#ff3b30;font-weight:600">${esc(note)}</span>` : ""}
    </div>
  </div>`;
}

// ---------- 1. Instant "you've been assigned" ----------
async function handleAssignment(record: any, oldRecord: any): Promise<number> {
  if (!record || record.kind !== "task") return 0;
  const task = record.data;
  if (!task || task.done) return 0;

  const now = new Set<string>((task.assignees ?? []).map((a: string) => canonName(a)).filter(Boolean));
  const before = new Set<string>(((oldRecord?.data?.assignees) ?? []).map((a: string) => canonName(a)).filter(Boolean));
  const added = [...now].filter((n) => !before.has(n));
  if (!added.length) return 0;

  const [profiles, studies] = await Promise.all([loadProfiles(), loadStudies()]);
  let sent = 0;
  for (const name of added) {
    const profile = profiles.get(name.toLowerCase());
    if (!profile) continue; // no account yet — nothing to email
    if (!(await claim(task.id, profile.email, "assigned"))) continue;
    const study = studyLabel(studies, task.studyId);
    try {
      await sendEmail(
        profile.email,
        `New task: ${task.title}`,
        shell("You've been assigned a task",
          `Hi ${esc(profile.name.split(" ")[0])}, this was just assigned to you.`,
          taskRow(task.title, study, task.due, ""),
          task.notes ? `<p style="font-size:13.5px;color:#3a3a3c;line-height:1.5;background:#f2f2f7;border-radius:9px;padding:11px 13px">${esc(task.notes)}</p>` : ""),
      );
      sent++;
    } catch (e) {
      // Give the claim back so this reminder is retried rather than lost forever.
      await releaseClaims([{ taskId: task.id, recipient: profile.email, kind: "assigned" }]);
      console.error(`assignment email to ${profile.email} failed:`, e);
    }
  }
  return sent;
}

// ---------- 2. Scheduled sweep for due-soon and overdue ----------
async function handleSweep(): Promise<number> {
  const { data, error } = await db.from("items").select("data").eq("kind", "task");
  if (error) throw error;
  const [profiles, studies] = await Promise.all([loadProfiles(), loadStudies()]);

  // Group by recipient so one person gets one email listing everything, not one per task.
  const buckets = new Map<string, { profile: Profile; dueSoon: any[]; overdue: any[]; claims: Claim[] }>();

  for (const row of data ?? []) {
    const task = row.data as any;
    if (!task || task.done || !task.due) continue;
    const left = daysUntil(task.due);
    const kind = left < 0 ? "overdue" : (left <= DUE_SOON_DAYS ? "due_soon" : null);
    if (!kind) continue;

    for (const rawName of task.assignees ?? []) {
      const profile = profiles.get(canonName(rawName).toLowerCase());
      if (!profile) continue;
      if (!(await claim(task.id, profile.email, kind))) continue; // already nudged
      let b = buckets.get(profile.email);
      if (!b) { b = { profile, dueSoon: [], overdue: [], claims: [] }; buckets.set(profile.email, b); }
      (kind === "overdue" ? b.overdue : b.dueSoon).push(task);
      b.claims.push({ taskId: task.id, recipient: profile.email, kind });
    }
  }

  let sent = 0;
  const failures: string[] = [];
  for (const { profile, dueSoon, overdue, claims } of buckets.values()) {
    const parts: string[] = [];
    if (overdue.length) {
      parts.push(`<div style="font-size:12px;font-weight:700;color:#ff3b30;letter-spacing:.4px;text-transform:uppercase;margin:0 0 8px 0">Overdue</div>`);
      for (const t of overdue) parts.push(taskRow(t.title, studyLabel(studies, t.studyId), t.due, `${Math.abs(daysUntil(t.due))} days late`));
    }
    if (dueSoon.length) {
      parts.push(`<div style="font-size:12px;font-weight:700;color:#8e8e93;letter-spacing:.4px;text-transform:uppercase;margin:${overdue.length ? "18px" : "0"} 0 8px 0">Coming up</div>`);
      for (const t of dueSoon) parts.push(taskRow(t.title, studyLabel(studies, t.studyId), t.due, ""));
    }
    const total = overdue.length + dueSoon.length;
    try {
      await sendEmail(
        profile.email,
        overdue.length
          ? `${overdue.length} overdue task${overdue.length > 1 ? "s" : ""} in Research Tracker`
          : `${total} task${total > 1 ? "s" : ""} due soon`,
        shell("Your research tasks",
          `Hi ${esc(profile.name.split(" ")[0])}, here's what needs your attention.`,
          parts.join("")),
      );
      sent++;
    } catch (e) {
      // One bad address shouldn't stop everyone else's reminders, and the claims go back so
      // this person is retried on the next run.
      await releaseClaims(claims);
      failures.push(`${profile.email}: ${e}`);
      console.error(`sweep email to ${profile.email} failed:`, e);
    }
  }
  if (failures.length) console.error(`${failures.length} recipient(s) failed`, failures);
  return sent;
}

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    // Database webhooks post {type, record, old_record}; the cron job posts {mode:"sweep"}.
    if (body?.record || body?.type) {
      const sent = await handleAssignment(body.record, body.old_record);
      return Response.json({ ok: true, mode: "assignment", sent });
    }
    const sent = await handleSweep();
    return Response.json({ ok: true, mode: "sweep", sent });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  } finally {
    // Leaving the socket open would keep the isolate alive and eventually exhaust Gmail's
    // concurrent-connection allowance.
    await closeSmtp();
  }
});
