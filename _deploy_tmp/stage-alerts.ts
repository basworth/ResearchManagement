// Stalled initiation stages — email the study team when a stage has sat in "Submitted" too long.
//
// This is the thing a CRCM actually chases: not "is there a task due", but "we sent the IRB
// packet seven weeks ago and heard nothing". Only stages with a status of Submitted and a
// recorded submitted date can stall, which is why those dates were worth capturing.
//
// Escalates at 30 / 60 / 90 days rather than nagging: each (study, stage, submitted-date,
// threshold, recipient) is emailed at most once, enforced by the same email_log unique
// constraint the task reminders use. Re-submitting a stage produces a new date and therefore a
// fresh series, so a genuine second attempt is tracked separately.
//
// Recipients are the STUDY TEAM, per Adam: the PI, everyone on the team list, and anyone with a
// task on that study. Names are resolved to accounts through the profile rows and the shared
// name-alias map, so historic spellings ("Chahla") still reach the right person.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://rushsportsresearch.netlify.app";
const SMTP_USER = Deno.env.get("SMTP_USER")!;
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD")!;
const SMTP_HOST = Deno.env.get("SMTP_HOST") ?? "smtp.gmail.com";
const SMTP_PORT = Number(Deno.env.get("SMTP_PORT") ?? "465");
const FROM_NAME = Deno.env.get("REMINDER_FROM_NAME") ?? "MOR Research Tracker";
const REPLY_TO = Deno.env.get("REMINDER_REPLY_TO") ?? "";
const THRESHOLDS = (Deno.env.get("STALL_DAYS") ?? "30,60,90")
  .split(",").map((n) => parseInt(n.trim(), 10)).filter((n) => n > 0).sort((a, b) => a - b);
// Days BEFORE IRB continuing-review expiry to warn at. Descending, because the alert we want is
// the tightest one crossed: at 25 days out you need the 30-day warning, not the 90-day one.
const IRB_STEPS = (Deno.env.get("IRB_EXPIRY_DAYS") ?? "90,60,30")
  .split(",").map((n) => parseInt(n.trim(), 10)).filter((n) => n > 0).sort((a, b) => b - a);
// Phases where a lapse actually exposes you. A published study with an expired approval is
// untidy; one still enrolling is a reportable problem.
const LIVE_PHASES = ["Initiation", "Enrolling", "Data Collection", "Data Extraction"];

const ROSTER_ID = "00000000-0000-0000-0000-000000000001";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" };
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const dayjs = (d: string) => Math.floor((Date.now() - new Date(d + "T00:00:00Z").getTime()) / 86400000);

const DEGREES = new Set(["ba","bs","bsc","ma","ms","msc","mba","md","do","phd","mph","msph","mha",
  "dpt","mpt","rn","np","pa","pac","mbbs","scd","edd","jd","pharmd","atc","crna","facs","faaos"]);
function stripDegrees(n: string) {
  const parts = String(n ?? "").trim().replace(/,/g, " ").split(/\s+/).filter(Boolean);
  while (parts.length > 1 && DEGREES.has(parts[parts.length - 1].toLowerCase().replace(/[.\-]/g, ""))) parts.pop();
  return parts.join(" ");
}

let smtp: SMTPClient | null = null;
function client() {
  if (!smtp) {
    smtp = new SMTPClient({
      connection: { hostname: SMTP_HOST, port: SMTP_PORT, tls: true, auth: { username: SMTP_USER, password: SMTP_PASSWORD } },
    });
  }
  return smtp;
}
async function send(to: string, subject: string, html: string) {
  const msg: Record<string, unknown> = {
    from: `${FROM_NAME} <${SMTP_USER}>`, to, subject, html,
    content: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  };
  if (REPLY_TO) msg.replyTo = REPLY_TO;
  await client().send(msg as never);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    const [{ data: rows, error }, { data: metaRow }] = await Promise.all([
      db.from("items").select("kind, data").in("kind", ["study", "task", "profile"]),
      db.from("items").select("data").eq("id", ROSTER_ID).maybeSingle(),
    ]);
    if (error) throw error;

    const studies = (rows ?? []).filter((r) => r.kind === "study").map((r) => r.data as never);
    const tasks = (rows ?? []).filter((r) => r.kind === "task").map((r) => r.data as never);
    const profiles = (rows ?? []).filter((r) => r.kind === "profile").map((r) => r.data as never);
    const stages = ((metaRow?.data as never)?.initiationStages ?? null) as { key: string; label: string }[] | null;
    const aliases = (((metaRow?.data as never)?.nameAliases ?? {}) as Record<string, string>);
    const labelFor = (key: string) =>
      (stages ?? []).find((st) => st.key === key)?.label ?? key;

    // name -> email, tolerant of degrees and of the merge tool's alias map.
    //
    // `alertEmail` wins over the sign-in address when it's set: people at Rush hold both a
    // rush.edu and a rushortho.com address and only read one of them, so the address they were
    // invited at is not reliably the address that reaches them.
    //
    // Linked spares are skipped. Two accounts for one person share a display name, so without
    // this the spare would overwrite the primary in the map and the alert would go to whichever
    // row happened to load last — which is exactly the coin-flip linking exists to remove.
    const byName = new Map<string, { email: string; name: string }>();
    for (const p of profiles as { name?: string; email?: string; alertEmail?: string; linkedTo?: string }[]) {
      if (!p?.email || !p?.name) continue;
      if (p.linkedTo) continue;
      const to = (p.alertEmail || "").trim() || p.email;
      const k = p.name.trim().toLowerCase();
      byName.set(k, { email: to, name: p.name });
      byName.set(stripDegrees(p.name).toLowerCase(), { email: to, name: p.name });
    }
    const resolve = (raw: string) => {
      const t = String(raw ?? "").trim();
      if (!t) return null;
      const direct = byName.get(t.toLowerCase());
      if (direct) return direct;
      const aliased = aliases[t.toLowerCase()];
      if (aliased) {
        const viaAlias = byName.get(aliased.toLowerCase());
        if (viaAlias) return viaAlias;
      }
      return byName.get(stripDegrees(t).toLowerCase()) ?? null;
    };

    async function claim(studyId: string, recipient: string, kind: string) {
      const { error: e } = await db.from("email_log").insert({ task_id: studyId, recipient, kind });
      if (!e) return true;
      if ((e as { code?: string }).code === "23505") return false;   // already sent
      throw e;
    }

    // Gather stalls per person, so someone on three studies gets one email, not three.
    const perPerson = new Map<string, { name: string; items: { study: string; irb: string; stage: string; days: number; since: string; kind: string }[]; irb: { study: string; irb: string; expiry: string; days: number; kind: string }[] }>();
    const bucketFor = (email: string, name: string) => {
      let b = perPerson.get(email);
      if (!b) { b = { name, items: [], irb: [] }; perPerson.set(email, b); }
      return b;
    };

    // Who should hear about a study: the PI, the team, and anyone holding a task on it.
    const teamOf = (s: Record<string, never>) => {
      const names = new Set<string>();
      String(s.pi ?? "").split(",").forEach((n) => { if (n.trim()) names.add(n.trim()); });
      ((s.team ?? []) as string[]).forEach((n) => { if (n) names.add(n); });
      (tasks as Record<string, never>[])
        .filter((t) => t.studyId === s.id)
        .forEach((t) => ((t.assignees ?? []) as string[]).forEach((a) => { if (a) names.add(a); }));
      return names;
    };

    for (const s of studies as Record<string, never>[]) {
      const progress = (s.initiationProgress ?? {}) as Record<string, { status?: string; submitted?: string }>;
      const stalls: { stage: string; days: number; since: string; threshold: number }[] = [];
      for (const [key, info] of Object.entries(progress)) {
        if (info?.status !== "Submitted" || !info?.submitted) continue;
        const days = dayjs(info.submitted);
        // Highest threshold crossed — one alert per escalation step, not one per threshold.
        const crossed = THRESHOLDS.filter((t) => days >= t).pop();
        if (!crossed) continue;
        stalls.push({ stage: labelFor(key), days, since: info.submitted, threshold: crossed });
      }
      if (!stalls.length) continue;

      for (const raw of teamOf(s)) {
        const who = resolve(raw);
        if (!who) continue;   // no account yet — nothing to email
        for (const st of stalls) {
          const kind = `stalled:${st.stage}:${st.since}:${st.threshold}`;
          if (!(await claim(String(s.id), who.email, kind))) continue;
          bucketFor(who.email, who.name).items.push({
            study: String(s.nickname || s.title || "Untitled study"),
            irb: String(s.irb ?? ""),
            stage: st.stage, days: st.days, since: st.since, kind,
          });
        }
      }
    }

    // IRB continuing review. Unlike a stalled stage this is a deadline, not an absence, so it
    // escalates as the date approaches and then keeps warning weekly once it's gone — a lapse
    // doesn't stop mattering just because we already mentioned it.
    for (const s of studies as Record<string, never>[]) {
      const expiry = String(s.irbExpiry ?? "").trim();
      if (!expiry) continue;
      if (LIVE_PHASES.indexOf(String(s.phase ?? "")) < 0) continue;
      const until = -dayjs(expiry);   // dayjs() counts days SINCE, so negate for days until
      let step: number;
      if (until < 0) {
        // Lapsed: renotify once a week rather than once ever, and never fall silent.
        step = -Math.floor(Math.abs(until) / 7);
      } else {
        const crossed = IRB_STEPS.find((d) => until <= d);
        if (crossed === undefined) continue;   // still further out than the widest warning
        step = crossed;
      }
      for (const raw of teamOf(s)) {
        const who = resolve(raw);
        if (!who) continue;
        const kind = `irbexpiry:${expiry}:${step}`;
        if (!(await claim(String(s.id), who.email, kind))) continue;
        bucketFor(who.email, who.name).irb.push({
          study: String(s.nickname || s.title || "Untitled study"),
          irb: String(s.irb ?? ""), expiry, days: until, kind,
        });
      }
    }

    let sent = 0;
    const failures: string[] = [];
    for (const [email, bucket] of perPerson) {
      const rowsHTML = bucket.items
        .sort((a, b) => b.days - a.days)
        .map((i) => `
          <tr>
            <td style="padding:7px 10px 7px 0;font-size:14px;color:#1c1c1e">${esc(i.study)}${i.irb ? ` <span style="color:#8e8e93">· ${esc(i.irb)}</span>` : ""}</td>
            <td style="padding:7px 10px;font-size:14px;color:#1c1c1e">${esc(i.stage)}</td>
            <td style="padding:7px 0;font-size:14px;font-weight:600;color:${i.days >= 90 ? "#d70015" : i.days >= 60 ? "#c93400" : "#8a6d00"};white-space:nowrap">${i.days} days</td>
          </tr>`).join("");
      // IRB expiry leads, because a lapse makes ongoing work reportable while a stalled stage
      // only costs time. Sorted soonest-first, lapsed at the top.
      const irbHTML = bucket.irb.length ? `
          <h2 style="font-size:17px;margin:0 0 10px;color:${bucket.irb.some((i) => i.days < 0) ? "#d70015" : "#1c1c1e"}">IRB continuing review</h2>
          <table style="border-collapse:collapse;width:100%;margin:0 0 18px">
            <tr style="text-align:left"><th style="padding:0 10px 6px 0;font-size:11.5px;color:#8e8e93;font-weight:600">STUDY</th><th style="padding:0 10px 6px;font-size:11.5px;color:#8e8e93;font-weight:600">EXPIRES</th><th style="padding:0 0 6px;font-size:11.5px;color:#8e8e93;font-weight:600">STATUS</th></tr>
            ${bucket.irb.sort((a, b) => a.days - b.days).map((i) => `
            <tr>
              <td style="padding:7px 10px 7px 0;font-size:14px;color:#1c1c1e">${esc(i.study)}${i.irb ? ` <span style="color:#8e8e93">· ${esc(i.irb)}</span>` : ""}</td>
              <td style="padding:7px 10px;font-size:14px;color:#1c1c1e">${esc(i.expiry)}</td>
              <td style="padding:7px 0;font-size:14px;font-weight:600;white-space:nowrap;color:${i.days < 0 ? "#d70015" : i.days <= 30 ? "#d70015" : "#c93400"}">${i.days < 0 ? `LAPSED ${Math.abs(i.days)}d ago` : `${i.days} days left`}</td>
            </tr>`).join("")}
          </table>
          ${bucket.irb.some((i) => i.days < 0) ? `<p style="font-size:14px;color:#d70015;line-height:1.5;margin:0 0 18px">
            Approval has expired on the study marked LAPSED. Enrolling or collecting data past that date is reportable — pause and check with the IRB before continuing.
          </p>` : `<p style="font-size:14px;color:#3a3a3c;line-height:1.5;margin:0 0 18px">
            Get the continuing-review packet in before the date. If a study has closed to enrolment, move its phase on and it'll drop off this list.
          </p>`}` : "";

      const stallHTML = bucket.items.length ? `
          <h2 style="font-size:17px;margin:0 0 10px">Waiting on a response</h2>
          <p style="font-size:14px;color:#3a3a3c;line-height:1.5">
            These initiation stages were submitted a while ago and haven't been marked as passed yet.
          </p>
          <table style="border-collapse:collapse;width:100%;margin:12px 0">
            <tr style="text-align:left"><th style="padding:0 10px 6px 0;font-size:11.5px;color:#8e8e93;font-weight:600">STUDY</th><th style="padding:0 10px 6px;font-size:11.5px;color:#8e8e93;font-weight:600">STAGE</th><th style="padding:0 0 6px;font-size:11.5px;color:#8e8e93;font-weight:600">WAITING</th></tr>
            ${rowsHTML}
          </table>
          <p style="font-size:14px;color:#3a3a3c;line-height:1.5">
            If one has actually come through, mark it passed in <a href="${SITE_URL}">the tracker</a> and it'll stop chasing. If it no longer applies, set it to N/A.
          </p>` : "";

      const html = `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px">
          <p style="font-size:14px;color:#3a3a3c;line-height:1.5;margin:0 0 14px">Hi ${esc(bucket.name.split(" ")[0])},</p>
          ${irbHTML}
          ${stallHTML}
          <p style="font-size:11.5px;color:#8e8e93;line-height:1.45;margin-top:20px">
            You're getting this because you're the PI, on the team, or assigned a task on these studies.
            Stages are chased once each at ${THRESHOLDS.join(", ")} days; IRB expiry warns at ${IRB_STEPS.join(", ")} days out and then weekly if it lapses. Open <a href="${SITE_URL}">the tracker</a> to update either.
          </p>
        </div>`;

      // Subject names the worst thing in the email, so it's triageable from a phone lock screen.
      const lapsed = bucket.irb.filter((i) => i.days < 0).length;
      const subject = lapsed
        ? `IRB approval lapsed on ${lapsed} stud${lapsed === 1 ? "y" : "ies"}`
        : bucket.irb.length
          ? `IRB continuing review due — ${bucket.irb.length} stud${bucket.irb.length === 1 ? "y" : "ies"}${bucket.items.length ? ` (+${bucket.items.length} stalled)` : ""}`
          : `${bucket.items.length} initiation stage${bucket.items.length === 1 ? "" : "s"} still waiting`;
      try {
        await send(email, subject, html);
        sent++;
      } catch (e) {
        // Give the claims back so a failed send is retried next run rather than lost forever.
        for (const i of [...bucket.items, ...bucket.irb]) {
          await db.from("email_log").delete().eq("recipient", email).eq("kind", i.kind);
        }
        failures.push(email);
        console.error(`stage-alerts email to ${email} failed:`, e);
      }
    }

    console.log(`stage-alerts: ${sent} sent, ${failures.length} failed`);
    return json({ ok: true, sent, failed: failures.length, thresholds: THRESHOLDS });
  } catch (e) {
    console.error("stage-alerts failed:", e);
    return json({ error: (e as Error)?.message || "failed" }, 500);
  } finally {
    if (smtp) { try { await smtp.close(); } catch { /* already closed */ } smtp = null; }
  }
});
