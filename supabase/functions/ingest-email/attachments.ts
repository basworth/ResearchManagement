// Files on a forwarded email — read them, check them for patient information, file them.   29 Oct 2026
//
// Adam: "can the email scrubber read the image?" — it couldn't; only the text of an email was read.
// Then: "if I put a data sheet in there that does not contain PHI, you should automatically move it
// into the website in the appropriate location under the correct study."
//
// Each attachment is shown to the model once, which does two things in one pass:
//   1. writes out what's in it (an infographic, a scanned page, a PDF, a spreadsheet's layout) so
//      the meeting reader can act on it exactly as if it had been typed into the email;
//   2. judges whether it identifies a patient. Anything it isn't sure about counts as yes.
// A file that may identify a patient is never stored and its contents are never passed on.
// A file that's only a signature logo or decoration is read but not filed.
//
// Formats: images and PDFs go to the model as they are; Word, Excel and PowerPoint are unzipped and
// their text sent; CSV / plain text as text. Anything else can't be checked, so it isn't stored.

import { unzipSync, strFromU8 } from "https://esm.sh/fflate@0.8.2";

export type Attachment = { name: string; mimeType: string; size?: number; data: string };
export type ReadFile = {
  name: string; mimeType: string; size: number; dataUrl: string;
  ok: boolean;            // read and judged
  phi: boolean;           // may identify a patient — never stored
  why: string;            // the model's reason, or why it couldn't be read
  text: string;           // what's in it, for the meeting reader
  worthFiling: boolean;   // false for logos, signatures, decoration
  studyGuess: string;     // the study it seems to belong to, by title, if the file says
};

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const READ_TOOL = {
  name: "read_file",
  description: "Report what this file contains and whether it identifies any patient.",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Everything in the file that matters to a research-project tracker: study titles, aims, hypotheses, design, people and roles, sites, sample sizes, dates, decisions, next steps, numbers. For a spreadsheet, describe its columns and what the rows are rather than copying every row. Plain text, at most about 3000 words." },
      containsPatientInfo: { type: "boolean", description: "True if ANY patient could be identified: patient names, MRNs, dates of birth, dates of service tied to a person, addresses, phone numbers or emails of patients, photos showing a face, or images with identifiers burnt in. De-identified data that uses only study IDs, ages or group-level numbers is NOT patient information. If you are unsure, answer true." },
      why: { type: "string", description: "One short sentence: what you saw that decided containsPatientInfo." },
      worthFiling: { type: "boolean", description: "False if this is only an email signature logo, an icon, or decoration; true for real content." },
      studyTitleGuess: { type: "string", description: "If the file names the study or project it belongs to, its title as written; else empty." },
    },
    required: ["text", "containsPatientInfo", "why", "worthFiling"],
  },
};

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function decodeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
// Office files are zip archives of XML. Pull out the words; layout doesn't matter here.
export function officeText(name: string, bytes: Uint8Array): string {
  const files = unzipSync(bytes);
  const get = (p: string) => files[p] ? strFromU8(files[p]) : "";
  const lower = name.toLowerCase();
  if (lower.endsWith(".docx")) {
    const xml = get("word/document.xml");
    return decodeXml(xml.replace(/<\/w:p>/g, "\n").replace(/<w:tab\/>/g, "\t").replace(/<[^>]+>/g, "")).trim();
  }
  if (lower.endsWith(".pptx")) {
    return Object.keys(files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
      .map((p, i) => `Slide ${i + 1}: ` + decodeXml((get(p).match(/<a:t>([^<]*)<\/a:t>/g) || []).map((t) => t.replace(/<\/?a:t>/g, "")).join(" ")))
      .join("\n").trim();
  }
  if (lower.endsWith(".xlsx")) {
    const shared = (get("xl/sharedStrings.xml").match(/<si>[\s\S]*?<\/si>/g) || [])
      .map((si) => decodeXml((si.match(/<t[^>]*>([^<]*)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, "")).join("")));
    const sheets = Object.keys(files).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p)).sort().slice(0, 3);
    return sheets.map((p, si) => {
      const rows = (get(p).match(/<row[\s\S]*?<\/row>/g) || []).slice(0, 200).map((row) =>
        (row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []).map((c) => {
          const v = (c.match(/<v>([^<]*)<\/v>/) || [])[1] ?? (c.match(/<t[^>]*>([^<]*)<\/t>/) || [])[1] ?? "";
          return / t="s"/.test(c) ? (shared[Number(v)] ?? "") : decodeXml(v);
        }).join("\t"));
      return `Sheet ${si + 1}:\n` + rows.join("\n");
    }).join("\n\n").trim();
  }
  return "";
}

export async function readAttachment(apiKey: string, model: string, a: Attachment): Promise<ReadFile> {
  const name = String(a.name || "file").slice(0, 200);
  const mimeType = String(a.mimeType || "application/octet-stream").toLowerCase();
  const data = String(a.data || "");
  const size = Number(a.size) || Math.floor(data.length * 3 / 4);
  const base: ReadFile = { name, mimeType, size, dataUrl: `data:${mimeType};base64,${data}`, ok: false, phi: true,
    why: "", text: "", worthFiling: false, studyGuess: "" };
  if (!data) return { ...base, why: "the file was empty" };
  if (size > MAX_FILE_BYTES) return { ...base, why: "too large to check (over 10 MB)" };

  let block: any = null;
  const lower = name.toLowerCase();
  try {
    if (IMAGE_TYPES.includes(mimeType)) block = { type: "image", source: { type: "base64", media_type: mimeType, data } };
    else if (mimeType === "application/pdf" || lower.endsWith(".pdf")) block = { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
    else if (/\.(docx|xlsx|pptx)$/.test(lower)) {
      const t = officeText(lower, b64ToBytes(data));
      if (!t) return { ...base, why: "couldn't read the document's contents" };
      block = { type: "text", text: `Contents of ${name}:\n\n` + t.slice(0, 60000) };
    } else if (/^text\//.test(mimeType) || /\.(csv|txt|md|tsv|json)$/.test(lower)) {
      block = { type: "text", text: `Contents of ${name}:\n\n` + new TextDecoder().decode(b64ToBytes(data)).slice(0, 60000) };
    } else {
      return { ...base, why: "this kind of file can't be checked for patient information, so it wasn't stored" };
    }
  } catch (e) {
    return { ...base, why: "couldn't open the file (" + ((e as Error)?.message || "unknown") + ")" };
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: 6000,
      tools: [READ_TOOL], tool_choice: { type: "auto" },
      messages: [{ role: "user", content: [block, { type: "text", text:
        `This file "${name}" was forwarded by email to an orthopedic research lab's study tracker. ` +
        `Use the read_file tool to report what it contains and whether it identifies any patient. ` +
        `The tracker must never hold patient-identifiable information, so be conservative.` }] }],
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) return { ...base, why: "the reader failed (" + res.status + ")" };
  const use = (out.content || []).find((c: any) => c.type === "tool_use");
  if (!use) return { ...base, why: "the reader gave no answer" };
  const r = use.input || {};
  return {
    ...base, ok: true,
    phi: r.containsPatientInfo !== false,
    why: String(r.why || "").slice(0, 300),
    text: r.containsPatientInfo === false ? String(r.text || "").slice(0, 20000) : "",
    worthFiling: r.worthFiling !== false,
    studyGuess: String(r.studyTitleGuess || "").slice(0, 200),
  };
}

// The study a file names, by title — only when exactly one study matches.
export function studyByGuess(guess: string, studies: any[]): any | null {
  const g = String(guess || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (g.length < 6) return null;
  const hits = (studies || []).filter((s) => {
    const t = String(s.title || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    const n = String(s.nickname || "").toLowerCase().trim();
    return (t && (t.includes(g) || g.includes(t))) || (n && n.length >= 4 && g.includes(n));
  });
  return hits.length === 1 ? hits[0] : null;
}
