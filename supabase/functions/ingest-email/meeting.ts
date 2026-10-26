// Meeting transcripts and meeting notes, forwarded by email → every action item, applied.
//                                                                              26 Oct 2026
//
// Adam: "i want it to do all the action items for a study and give a summary back over email of
// the updates applied to the same people that were on the email ... there should be an option to
// undo some of them if the reviewer doesn't like them." Then: undo for two days, so there is no
// backlog — "but keep a history of all changes in case we have to verify versions etc".
//
// WHY A MODEL HERE AND NOWHERE ELSE IN INGEST. The rules in rules.ts read letters a journal or an
// IRB wrote, which say the same things in the same words every time. A meeting does not: "we're
// up to thirteen", "you got to add Morgan on there", "this still says synovial fluid biomarkers"
// — none of that is a pattern. The model READS; it never decides what exists. Every study id it
// returns is checked against the lab's own list, every name against the roster, every phase and
// status against the app's own vocabularies, and anything that fails a check is reported back as
// "not applied" rather than guessed at.
//
// WHAT IS KEPT. One record per meeting (kind "suggestion", source "meeting") holding every change
// with its before and after value and the words that justified it. For MEETING_UNDO_HOURS it sits
// at the top of Suggested Updates; after that it folds into the history and each study's own page
// ("i dont want to refuse the undo necessarily i just dont want there to be a big messy list").
// Undo works at any age. It writes `undoneAt` and `undoneBy` onto the change — it never removes the
// change from the record.
//
// PATIENTS. The tracker holds no PHI. A transcript names people who are patients, which the
// pattern scrubber in rules.ts cannot catch (it removes numbers, not names). So the model is asked
// to list every patient identifier it saw, and those strings are cut from everything stored —
// the transcript, the evidence quotes, the notes — before anything is written.

// deno-lint-ignore-file no-explicit-any
export const MEETING_UNDO_HOURS = 48;
export const MEETING_MIN_CONFIDENCE = 0.7;

const PHASES = [
  "Concept", "Initiation", "Enrolling", "Data Extraction", "Experiments", "Data Collection",
  "Analysis", "Manuscript", "Submitted", "Revisions Required", "Accepted / In Press", "Published", "On Hold",
];
const DECISIONS = ["Awaiting decision", "Minor revision", "Major revision", "Accepted", "Rejected"];
const ABS_STATUSES = ["Planned", "Submitted", "Accepted", "Rejected", "Presented"];
const ABS_FORMATS = ["Poster", "Podium", "E-Poster"];

// ---------- is this a meeting? ----------
// A timestamped transcript (Zoom, Teams, Otter, Plaud: "00:01:23 Speaker 1"), a speaker-labelled
// one ("Will Lee: …"), or a subject line that says what it is. A journal letter has none of these,
// so the existing rules keep handling those exactly as before.
export function looksLikeMeeting(subject: string, body: string): boolean {
  const s = String(subject || "");
  const b = String(body || "");
  if (/\b(transcript|meeting notes|meeting minutes|minutes|action items|research meeting|lab meeting|team meeting)\b/i.test(s)) return true;
  const stamped = (b.match(/^\s*\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s+(?:speaker\s*\d+|[A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+)?)\s*$/gim) || []).length;
  const labelled = (b.match(/^\s*(?:speaker\s*\d+|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*:\s+\S/gm) || []).length;
  return stamped >= 6 || labelled >= 10;
}

// ---------- what the model is shown ----------
// Every study that is still moving. Published work is left out: a meeting can't change it, and
// including 276 finished papers would bury the 120 that matter.
export function studyContext(studies: any[]): any[] {
  return (studies || [])
    .filter((s) => s && s.id && s.phase !== "Published")
    .map((s) => ({
      id: s.id,
      nickname: s.nickname || "",
      title: String(s.title || "").slice(0, 160),
      phase: s.phase || "",
      pi: s.pi || "",
      team: Array.isArray(s.team) ? s.team : (s.team ? [s.team] : []),
      enrolled: s.enrollCurrent === "" || s.enrollCurrent == null ? null : s.enrollCurrent,
      enrollTarget: s.enrollTarget === "" || s.enrollTarget == null ? null : s.enrollTarget,
      grant: (s.grant && s.grant.source) || "",
      journal: s.journal || "",
      decision: s.decision || "",
      milestones: (s.milestones || []).filter((m: any) => m && !m.done).map((m: any) => ({ name: m.name, date: m.date || "" })),
      abstracts: (s.abstracts || []).map((a: any) => ({ meeting: a.meeting, status: a.status })),
    }));
}

export const EXTRACT_TOOL = {
  name: "record_updates",
  description: "Record every update to the research tracker that the meeting decided or reported.",
  input_schema: {
    type: "object",
    properties: {
      updates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["enrollment", "addTeamMember", "title", "phase", "addMilestone",
              "updateMilestone", "addTask", "addNote", "abstract", "journalDecision", "grantSource", "newStudy"] },
            studyId: { type: "string", description: "Exactly one id from the study list. Omit only for newStudy." },
            enrolled: { type: "integer" }, enrollTarget: { type: "integer" },
            name: { type: "string", description: "addTeamMember: the person, as written in the roster if they are on it" },
            title: { type: "string" },
            phase: { type: "string", enum: PHASES },
            milestoneName: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, done: { type: "boolean" },
            task: { type: "string", description: "addTask: the action, imperative, one line" },
            assignees: { type: "array", items: { type: "string" } },
            due: { type: "string", description: "YYYY-MM-DD, only if a date or deadline was actually stated" },
            note: { type: "string" },
            meeting: { type: "string", description: "abstract: society and year, e.g. 'AANA 2027'" },
            status: { type: "string", enum: ABS_STATUSES },
            format: { type: "string", enum: ABS_FORMATS },
            decision: { type: "string", enum: DECISIONS }, journal: { type: "string" },
            source: { type: "string", description: "grantSource: the funder" },
            pi: { type: "string" }, team: { type: "array", items: { type: "string" } },
            evidence: { type: "string", description: "What was said that justifies this, paraphrased in under 200 characters. Never include a patient's name or identifier." },
            confidence: { type: "number", description: "0 to 1: how sure you are this was decided or stated, and that it belongs to this study" },
          },
          required: ["type", "evidence", "confidence"],
        },
      },
      notMapped: {
        type: "array",
        description: "Action items from the meeting that concern the tracker but fit none of the update types, or that you could not attribute to a study.",
        items: { type: "object", properties: { text: { type: "string" }, why: { type: "string" } }, required: ["text"] },
      },
      patientIdentifiers: {
        type: "array", items: { type: "string" },
        description: "Every string in the transcript that identifies a patient: names, initials used as names, MRNs, dates of birth. Exactly as written.",
      },
    },
    required: ["updates", "notMapped", "patientIdentifiers"],
  },
};

export function extractPrompt(transcript: string, studies: any[], roster: string[], today: string): string {
  return [
    `Today is ${today}. Below is a research meeting (a transcript or notes) from an orthopaedic research lab, followed by the lab's active studies and its roster of people.`,
    ``,
    `Find every update the meeting makes to the lab's research tracker, and record each one with the record_updates tool. Always answer by calling record_updates exactly once, even if there are no updates:`,
    `- enrollment: a stated current enrollment count (and target if stated).`,
    `- addTeamMember: someone who should be on a study's team and is not (check the study's team list).`,
    `- title: the study's title is wrong and the meeting says what it should be or what must come out of it. Write the corrected title.`,
    `- phase: the study has clearly moved stage (e.g. a manuscript was rejected and is being reworked → Manuscript).`,
    `- addMilestone / updateMilestone: a target date set or changed ("submit by …", "this is way too long from now").`,
    `- addTask: a concrete action someone agreed to do. Assign it to the roster names of whoever will do it.`,
    `- addNote: a status update worth keeping on the study that is not one of the above (recruitment status, a decision made, a plan).`,
    `- abstract: an abstract submitted to / accepted at / presented at a society meeting.`,
    `- journalDecision: a journal decision on a submitted manuscript.`,
    `- grantSource: the study's funder is stated and the study has none recorded.`,
    `- newStudy: a new project the group agreed to start or explore that is not in the study list.`,
    ``,
    `Rules:`,
    `- studyId must be copied exactly from the study list. If you cannot tell which study something belongs to, put it in notMapped instead of guessing.`,
    `- People: use the roster spelling when the person is clearly on the roster (a first name or nickname that matches exactly one roster entry counts). Otherwise write the name as spoken.`,
    `- Do not record chit-chat, opinions, or things that are already true in the study list.`,
    `- Never put a patient's name or any identifier in any field. List every patient identifier you see in patientIdentifiers.`,
    `- Dates as YYYY-MM-DD, resolved against today. Leave out a date nobody stated.`,
    `- confidence below 0.7 means "probably, but check": still record it.`,
    ``,
    `ROSTER:`,
    roster.join("; "),
    ``,
    `STUDIES (JSON):`,
    JSON.stringify(studies),
    ``,
    `MEETING:`,
    transcript,
  ].join("\n");
}

// The one network call, isolated so the tests can stand a fixture in for it.
export async function callModel(apiKey: string, model: string, prompt: string): Promise<any> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: 16000,
      // Newer models refuse a forced tool_choice ("tool"/"any"), so the tool is offered and the
      // prompt asks for it; a reply without it is still caught below.
      tools: [EXTRACT_TOOL], tool_choice: { type: "auto" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("model " + res.status + ": " + (out?.error?.message || "request failed"));
  if (out.stop_reason === "max_tokens") throw new Error("model reply was cut off");
  const use = (out.content || []).find((c: any) => c.type === "tool_use");
  if (!use) throw new Error("model gave no structured reply");
  return use.input || {};
}

// ---------- patients out of everything ----------
export function redactAll(text: string, identifiers: string[]): string {
  let out = String(text || "");
  const ids = (identifiers || []).map((x) => String(x || "").trim()).filter((x) => x.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const id of ids) {
    const re = new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out = out.replace(re, "[patient removed]");
  }
  return out;
}

// ---------- people ----------
// Roster spelling when we can be sure; as spoken otherwise, and said so. "Cat" → "Catherine Yuh"
// only because exactly one roster name starts that way.
export function canonPerson(name: string, roster: string[]): { name: string; known: boolean } {
  const n = String(name || "").trim();
  if (!n) return { name: "", known: false };
  const low = n.toLowerCase();
  const exact = roster.find((r) => r.toLowerCase() === low);
  if (exact) return { name: exact, known: true };
  const byFirst = roster.filter((r) => {
    const first = r.toLowerCase().split(/\s+/)[0];
    return first === low || (low.length >= 3 && first.startsWith(low));
  });
  if (byFirst.length === 1) return { name: byFirst[0], known: true };
  const bySurname = roster.filter((r) => r.toLowerCase().split(/\s+/).slice(-1)[0] === low);
  if (bySurname.length === 1) return { name: bySurname[0], known: true };
  return { name: n, known: false };
}

const isDate = (d: unknown) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
const label = (s: any) => s.nickname || s.title;

// ---------- validate and apply ----------
// Pure: takes the model's reply and the lab's data, mutates the study objects it is handed, and
// returns what it did plus the new rows to write. Every change carries an `undo` describing
// exactly how to reverse it, so the app needs no knowledge of how it was made.
export function applyMeeting(extracted: any, studies: any[], roster: string[], env: { uid: () => string; today: string; by: string }) {
  const byId = new Map(studies.map((s: any) => [s.id, s]));
  const applied: any[] = [];
  const notApplied: any[] = [];
  const newTasks: any[] = [];
  const newStudies: any[] = [];
  const touched = new Set<string>();
  const ids = (extracted?.patientIdentifiers || []) as string[];
  const clean = (t: unknown) => redactAll(String(t ?? ""), ids).trim();

  for (const u of (extracted?.updates || [])) {
    const evidence = clean(u.evidence).slice(0, 240);
    const skip = (why: string) => notApplied.push({ text: describe(u), why, evidence });
    if ((Number(u.confidence) || 0) < MEETING_MIN_CONFIDENCE) { skip("not sure enough it was decided — check it"); continue; }

    if (u.type === "newStudy") {
      const title = clean(u.title);
      if (!title) { skip("no title"); continue; }
      const s: any = {
        id: env.uid(), title, nickname: "", phase: "Concept", pi: canonPerson(u.pi || "", roster).name || "",
        team: (u.team || []).map((n: string) => canonPerson(n, roster).name).filter(Boolean),
        design: "", irb: "", enrollCurrent: "", enrollTarget: "",
        noteEntries: [{ id: env.uid(), text: "Started from a meeting update: " + evidence, date: env.today, archivedOn: "" }],
        fromMeeting: true,
      };
      newStudies.push(s);
      applied.push({ id: env.uid(), type: u.type, studyId: s.id, study: title, label: "New study", from: "", to: title,
        evidence, undo: { kind: "studyShelve", studyId: s.id } });
      continue;
    }

    const s: any = byId.get(String(u.studyId || ""));
    if (!s) { skip("couldn't tell which study"); continue; }
    if (s.phase === "Published" && u.type !== "addNote") { skip(label(s) + " is published"); continue; }
    const rec = (lbl: string, from: unknown, to: unknown, undo: any) => {
      applied.push({ id: env.uid(), type: u.type, studyId: s.id, study: label(s), label: lbl,
        from: String(from ?? ""), to: String(to ?? ""), evidence, undo });
      touched.add(s.id);
    };

    switch (u.type) {
      case "enrollment": {
        if (Number.isInteger(u.enrolled) && u.enrolled >= 0 && String(s.enrollCurrent) !== String(u.enrolled)) {
          const was = s.enrollCurrent ?? ""; s.enrollCurrent = String(u.enrolled);
          rec("Enrolled", was, s.enrollCurrent, { kind: "field", path: "enrollCurrent", prev: was, now: s.enrollCurrent });
        }
        if (Number.isInteger(u.enrollTarget) && u.enrollTarget > 0 && String(s.enrollTarget) !== String(u.enrollTarget)) {
          const was = s.enrollTarget ?? ""; s.enrollTarget = String(u.enrollTarget);
          rec("Enrollment target", was, s.enrollTarget, { kind: "field", path: "enrollTarget", prev: was, now: s.enrollTarget });
        }
        if (!Number.isInteger(u.enrolled) && !Number.isInteger(u.enrollTarget)) skip("no number given");
        break;
      }
      case "addTeamMember": {
        const p = canonPerson(u.name, roster);
        if (!p.name) { skip("no name"); break; }
        if (!Array.isArray(s.team)) s.team = s.team ? [s.team] : [];
        if (s.team.some((t: string) => String(t).toLowerCase() === p.name.toLowerCase())) { skip(p.name + " is already on the team"); break; }
        s.team.push(p.name);
        rec("Team", "", "added " + p.name + (p.known ? "" : " (not on the roster yet)"), { kind: "teamRemove", name: p.name });
        break;
      }
      case "title": {
        const t = clean(u.title);
        if (!t || t === s.title) { skip("no new title"); break; }
        const was = s.title; s.title = t;
        rec("Title", was, t, { kind: "field", path: "title", prev: was, now: t });
        break;
      }
      case "phase": {
        if (PHASES.indexOf(u.phase) < 0 || u.phase === s.phase) { skip("not a change of phase"); break; }
        const was = s.phase; s.phase = u.phase;
        rec("Phase", was, u.phase, { kind: "field", path: "phase", prev: was, now: u.phase });
        break;
      }
      case "addMilestone": {
        const name = clean(u.milestoneName);
        if (!name) { skip("no milestone named"); break; }
        if (!Array.isArray(s.milestones)) s.milestones = [];
        const m = { id: env.uid(), name, date: isDate(u.date) ? u.date : "", done: false, fromMeeting: true };
        s.milestones.push(m);
        rec("Milestone", "", name + (m.date ? " by " + m.date : ""), { kind: "milestoneRemove", milestoneId: m.id });
        break;
      }
      case "updateMilestone": {
        const want = String(u.milestoneName || "").trim().toLowerCase();
        const list = (s.milestones || []).filter((m: any) => m && !m.done);
        const m = list.find((x: any) => String(x.name || "").toLowerCase() === want)
          || (list.length === 1 ? list[0] : null);
        if (!m) { skip("couldn't tell which milestone"); break; }
        if (!m.id) m.id = env.uid();
        const prev = { date: m.date || "", done: !!m.done };
        if (isDate(u.date)) m.date = u.date;
        if (u.done === true) m.done = true;
        if (m.date === prev.date && m.done === prev.done) { skip("no change to the milestone"); break; }
        rec("Milestone: " + m.name, prev.date + (prev.done ? " (done)" : ""), (m.date || "") + (m.done ? " (done)" : ""),
          { kind: "milestoneRestore", milestoneId: m.id, prev, now: { date: m.date || "", done: !!m.done } });
        break;
      }
      case "addTask": {
        const title = clean(u.task);
        if (!title) { skip("no task"); break; }
        const who = (u.assignees || []).map((n: string) => canonPerson(n, roster).name).filter(Boolean);
        const t = { id: env.uid(), title, studyId: s.id, due: isDate(u.due) ? u.due : "", assignees: who,
          notes: "From a meeting update: " + evidence, done: false, fromMeeting: true };
        newTasks.push(t);
        rec("Task", "", title + (who.length ? " — " + who.join(", ") : "") + (t.due ? " (due " + t.due + ")" : ""),
          { kind: "taskShelve", taskId: t.id });
        break;
      }
      case "addNote": {
        const text = clean(u.note);
        if (!text) { skip("empty note"); break; }
        if (!Array.isArray(s.noteEntries)) s.noteEntries = [];
        const n = { id: env.uid(), text: "From the meeting: " + text, date: env.today, archivedOn: "" };
        s.noteEntries.push(n);
        rec("Note", "", text, { kind: "noteArchive", noteId: n.id });
        break;
      }
      case "abstract": {
        const meeting = clean(u.meeting);
        if (!meeting || ABS_STATUSES.indexOf(u.status) < 0) { skip("no meeting or status"); break; }
        if (!Array.isArray(s.abstracts)) s.abstracts = [];
        const key = (v: string) => String(v || "").toLowerCase().replace(/\s+/g, " ").trim();
        const ex = s.abstracts.find((a: any) => key(a.meeting) === key(meeting));
        if (ex) {
          if (ex.status === u.status && (!u.format || ex.format === u.format)) { skip("already recorded"); break; }
          const prev = { status: ex.status, format: ex.format || "" };
          ex.status = u.status; if (u.format) ex.format = u.format;
          if (!ex.id) ex.id = env.uid();
          rec("Abstract: " + meeting, prev.status, ex.status + (ex.format ? " — " + ex.format : ""),
            { kind: "abstractRestore", abstractId: ex.id, prev, now: { status: ex.status, format: ex.format || "" } });
        } else {
          const a = { id: env.uid(), meeting, date: env.today, status: u.status, format: u.format || "", fromMeeting: true };
          s.abstracts.push(a);
          rec("Abstract: " + meeting, "", a.status + (a.format ? " — " + a.format : ""), { kind: "abstractRemove", abstractId: a.id });
        }
        break;
      }
      case "journalDecision": {
        if (DECISIONS.indexOf(u.decision) < 0 || u.decision === s.decision) { skip("not a new decision"); break; }
        const was = s.decision || ""; s.decision = u.decision;
        rec("Journal decision" + (u.journal ? " (" + clean(u.journal) + ")" : ""), was, u.decision,
          { kind: "field", path: "decision", prev: was, now: u.decision });
        break;
      }
      case "grantSource": {
        const src = clean(u.source);
        if (!src) { skip("no funder named"); break; }
        if (!s.grant || typeof s.grant !== "object") s.grant = {};
        if (String(s.grant.source || "").toLowerCase() === src.toLowerCase()) { skip("already recorded"); break; }
        const was = s.grant.source || ""; const wasOn = !!s.grant.enabled;
        s.grant.source = src; s.grant.enabled = true;
        rec("Grant source", was, src, { kind: "field", path: "grant.source", prev: was, now: src, prevEnabled: wasOn });
        break;
      }
      default: skip("not something the tracker can record yet");
    }
  }
  for (const n of (extracted?.notMapped || [])) {
    notApplied.push({ text: clean(n.text), why: clean(n.why) || "nothing in the tracker to put it in" });
  }
  return { applied, notApplied, newTasks, newStudies, touched: [...touched] };
}

function describe(u: any): string {
  const v = u.enrolled ?? u.name ?? u.title ?? u.phase ?? u.milestoneName ?? u.task ?? u.note ?? u.meeting ?? u.decision ?? u.source ?? "";
  return `${u.type}${v !== "" ? ": " + String(v).slice(0, 140) : ""}`;
}

// ---------- the reply ----------
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export function summaryEmail(rec: { applied: any[]; notApplied: any[]; undoUntil: string; link: string; subject: string; by: string }) {
  const groups = new Map<string, any[]>();
  rec.applied.forEach((a) => { if (!groups.has(a.study)) groups.set(a.study, []); groups.get(a.study)!.push(a); });
  const until = new Date(rec.undoUntil);
  const untilText = until.toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const head = rec.applied.length
    ? `${rec.applied.length} update${rec.applied.length === 1 ? "" : "s"} applied to ${groups.size} stud${groups.size === 1 ? "y" : "ies"}`
    : "Nothing in the meeting changed the tracker";
  const line = (a: any) => `${a.label}: ${a.from ? a.from + " → " : ""}${a.to}`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:600px;color:#1c1c1e">
    <div style="font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:#8e8e93;font-weight:700">Research Tracker · from the meeting ${esc(rec.by ? "sent by " + rec.by : "")}</div>
    <h2 style="font-size:18px;margin:6px 0 10px 0">${esc(head)}</h2>
    ${[...groups.entries()].map(([study, list]) => `
      <div style="border:1px solid #e5e5ea;border-radius:10px;padding:10px 14px;margin:8px 0">
        <div style="font-size:14.5px;font-weight:700;margin-bottom:4px">${esc(study)}</div>
        ${list.map((a) => `<div style="font-size:13.5px;padding:2px 0">${esc(a.label)}: ${a.from ? `<span style="color:#8e8e93">${esc(a.from)} →</span> ` : ""}<b>${esc(a.to)}</b></div>`).join("")}
      </div>`).join("")}
    ${rec.notApplied.length ? `
      <div style="font-size:11px;font-weight:700;color:#8e8e93;letter-spacing:.4px;margin:16px 0 4px">NOT APPLIED — FOR A PERSON TO HANDLE</div>
      ${rec.notApplied.map((n) => `<div style="font-size:13.5px;padding:2px 0">${esc(n.text)} <span style="color:#8e8e93">(${esc(n.why)})</span></div>`).join("")}` : ""}
    ${rec.applied.length ? `<p style="margin:18px 0 6px 0"><a href="${esc(rec.link)}" style="background:#0a84ff;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:9px 16px;border-radius:9px;display:inline-block">Review or undo any of these</a></p>
    <p style="font-size:12px;color:#8e8e93;line-height:1.45;margin:4px 0 0 0">This stays at the top of Suggested Updates until ${esc(untilText)} (Chicago), then moves to the history and to each study's page. You can still undo from there, and the record of what changed and why is kept for good.</p>` : ""}
  </div>`;
  const text = [head, ""].concat(
    [...groups.entries()].flatMap(([study, list]) => [study, ...list.map((a) => "  - " + line(a)), ""]),
    rec.notApplied.length ? ["Not applied — for a person to handle:", ...rec.notApplied.map((n) => "  - " + n.text + " (" + n.why + ")"), ""] : [],
    rec.applied.length ? ["Review or undo: " + rec.link, "(At the top of Suggested Updates until " + untilText + ", then in the history and on each study's page.)"] : [],
  ).join("\n");
  // One line, no runs of spaces: see notifyForwarder for the "=20" this avoids.
  return { html: html.replace(/\s*\n\s*/g, "").replace(/ {2,}/g, " "), text };
}

// Addresses on the thread, minus the tracker's own mailboxes, deduplicated.
export function threadRecipients(fields: string[], exclude: string[]): string[] {
  const out: string[] = [];
  const skip = new Set(exclude.map((x) => x.toLowerCase()));
  for (const f of fields) {
    for (const part of String(f || "").split(",")) {
      const m = /<([^>]+)>/.exec(part);
      const addr = (m ? m[1] : part).trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) || skip.has(addr) || out.indexOf(addr) >= 0) continue;
      // Any address on the tracker's own domain is a tracker mailbox — studyupdates@, or a
      // per-lab alias added later — and replying to it would loop the summary back in.
      if (/@(?:[\w-]+\.)*studypipeline\.com$/.test(addr)) continue;
      out.push(addr);
    }
  }
  return out;
}
