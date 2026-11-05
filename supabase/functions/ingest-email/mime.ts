// Emails forwarded AS ATTACHMENTS.   5 Nov 2026
//
// Adam: "I forwarded some emails that were batched together … They would have come through as
// attachments for study updates like poster and podium acceptances. I never got anything back."
// Outlook's "Forward as attachment" (and Gmail's) wraps each original email as a message/rfc822
// part. Gmail's Apps Script getAttachments() doesn't return those parts at all, so the tracker saw
// only the covering note: one forward with 12 acceptance emails attached arrived as a blank
// forward and became a single note.
//
// The Gmail script now also sends the forward's raw MIME whenever it carries attached emails.
// This file pulls each attached email out of it: its From / Date / Subject and its text, plus any
// files inside it (an acceptance letter as a PDF), which go through the same patient-information
// check as any other file.

export type AttachedEmail = { subject: string; from: string; date: string; text: string };
export type NestedFile = { name: string; mimeType: string; data: string; size: number };

type Part = { headers: Record<string, string>; body: string };

function splitHeaders(chunk: string): Part {
  const idx = chunk.search(/\r?\n\r?\n/);
  const head = idx >= 0 ? chunk.slice(0, idx) : chunk;
  const body = idx >= 0 ? chunk.slice(idx).replace(/^\r?\n\r?\n/, "") : "";
  const headers: Record<string, string> = {};
  // Unfold continuation lines, then read "Name: value".
  head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/).forEach((line) => {
    const m = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2];
  });
  return { headers, body };
}

function param(h: string, name: string): string {
  const m = (h || "").match(new RegExp(name + `\\*?=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? "") : "";
}

function bytesFromBinaryString(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function binStr(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}

function decodeCharset(bytes: Uint8Array, charset: string): string {
  try { return new TextDecoder((charset || "utf-8").toLowerCase()).decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}

function qpToBytes(s: string): Uint8Array {
  const t = s.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(t.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(out);
}

function b64ToBytes(s: string): Uint8Array {
  try { return bytesFromBinaryString(atob(s.replace(/[^A-Za-z0-9+/=]/g, ""))); } catch { return new Uint8Array(); }
}

function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function partBytes(p: Part): Uint8Array {
  const enc = (p.headers["content-transfer-encoding"] || "").toLowerCase().trim();
  if (enc === "base64") return b64ToBytes(p.body);
  if (enc === "quoted-printable") return qpToBytes(p.body);
  return bytesFromBinaryString(p.body);
}

// "=?utf-8?B?…?=" / "=?utf-8?Q?…?=" in Subject and From.
export function decodeWords(s: string): string {
  return String(s || "").replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, cs, kind, txt) => {
    const bytes = kind.toUpperCase() === "B" ? b64ToBytes(txt) : qpToBytes(txt.replace(/_/g, " "));
    return decodeCharset(bytes, cs);
  }).replace(/\?=\s+=\?/g, "?==?");
}

function htmlToText(h: string): string {
  return h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function children(p: Part): Part[] {
  const ct = p.headers["content-type"] || "text/plain";
  if (/^multipart\//i.test(ct)) {
    const b = param(ct, "boundary");
    if (!b) return [];
    return p.body.split(new RegExp("\\r?\\n?--" + b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:--)?[ \\t]*\\r?\\n?"))
      .filter((c) => c.trim() && !/^--\s*$/.test(c.trim()))
      .map(splitHeaders);
  }
  return [];
}

// Walk one message: its best text (plain preferred, else HTML), the emails attached to it, and the
// files inside it.
function walk(p: Part, out: { text: string[]; html: string[]; emails: Part[]; files: NestedFile[] }, depth: number) {
  if (depth > 6) return;
  const ct = (p.headers["content-type"] || "text/plain").toLowerCase();
  const disp = (p.headers["content-disposition"] || "").toLowerCase();
  const name = decodeWords(param(p.headers["content-disposition"] || "", "filename") || param(p.headers["content-type"] || "", "name"));
  if (/^message\/rfc822/.test(ct)) {
    const enc = (p.headers["content-transfer-encoding"] || "").toLowerCase();
    const inner = enc === "base64" || enc === "quoted-printable" ? binStr(partBytes(p)) : p.body;
    out.emails.push(splitHeaders(inner));
    return;
  }
  if (/^multipart\//.test(ct)) { children(p).forEach((c) => walk(c, out, depth + 1)); return; }
  const isAttachment = /attachment/.test(disp) || (!!name && !/^text\//.test(ct));
  if (isAttachment) {
    if (/\.eml$/i.test(name)) { out.emails.push(splitHeaders(binStr(partBytes(p)))); return; }
    const bytes = partBytes(p);
    out.files.push({ name: name || "file", mimeType: ct.split(";")[0].trim(), data: bytesToB64(bytes), size: bytes.length });
    return;
  }
  if (/^text\/plain/.test(ct)) out.text.push(decodeCharset(partBytes(p), param(ct, "charset")));
  else if (/^text\/html/.test(ct)) out.html.push(htmlToText(decodeCharset(partBytes(p), param(ct, "charset"))));
}

// Every email attached to `rawMime`, however deep (an attached email that itself has attachments),
// with its text and the files inside it. The outer message's own body is NOT returned — the Gmail
// script already sends that.
export function attachedEmails(rawMime: string, limit = 25): { emails: AttachedEmail[]; files: NestedFile[] } {
  const top = splitHeaders(String(rawMime || ""));
  const seed = { text: [] as string[], html: [] as string[], emails: [] as Part[], files: [] as NestedFile[] };
  walk(top, seed, 0);
  const emails: AttachedEmail[] = [];
  const files: NestedFile[] = [];
  const queue = seed.emails.slice();
  while (queue.length && emails.length < limit) {
    const m = queue.shift()!;
    const o = { text: [] as string[], html: [] as string[], emails: [] as Part[], files: [] as NestedFile[] };
    walk(m, o, 0);
    emails.push({
      subject: decodeWords(m.headers["subject"] || ""),
      from: decodeWords(m.headers["from"] || ""),
      date: m.headers["date"] || "",
      text: (o.text.join("\n").trim() || o.html.join("\n").trim()).slice(0, 20000),
    });
    o.files.forEach((f) => files.push(f));
    o.emails.forEach((e) => queue.push(e));
  }
  return { emails, files };
}

// Does the raw message carry attached emails at all? Cheap check before parsing.
export function hasAttachedEmails(rawMime: string): boolean {
  return /content-type:\s*message\/rfc822/i.test(rawMime || "") || /filename\*?=\s*"?[^"\r\n]*\.eml"?/i.test(rawMime || "");
}
