// Images the person attaches (from Slack, or any API client): saved into the
// task's workspace so the agent can open them, and named in the message text.
// Tested on their own: `node agents/test-attachments.mjs`.
//
// An attachment is { name, data } with data in base64. The type comes from the
// file's bytes, never from its name or a claimed mimetype.
import { mkdirSync, writeFileSync, chownSync } from 'node:fs';

export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_BODY_BYTES = Math.ceil(MAX_ATTACHMENTS * MAX_ATTACHMENT_BYTES * 4 / 3) + 400000;

const SIGNATURES = [
  ['png', (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a],
  ['jpg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['gif', (b) => b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))],
  ['webp', (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];
export const imageType = (buf) => SIGNATURES.find(([, ok]) => ok(buf))?.[0] ?? null;

// a file name safe on disk and readable in a prompt
export function safeName(name, ext, i) {
  const base = String(name ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '').normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${String(i + 1).padStart(2, '0')}-${base || 'image'}.${ext}`;
}

// → { files: [{ name, path, bytes }], skipped: [reason] }; never throws on a bad file,
// it is skipped with a reason so the person hears why
export function decodeAttachments(list) {
  const files = [], skipped = [];
  for (const [i, a] of (Array.isArray(list) ? list : []).entries()) {
    if (files.length >= MAX_ATTACHMENTS) { skipped.push(`${a?.name ?? `file ${i + 1}`}: more than ${MAX_ATTACHMENTS} images`); continue; }
    const buf = Buffer.from(String(a?.data ?? ''), 'base64');
    if (!buf.length) { skipped.push(`${a?.name ?? `file ${i + 1}`}: empty`); continue; }
    if (buf.length > MAX_ATTACHMENT_BYTES) { skipped.push(`${a?.name ?? `file ${i + 1}`}: over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`); continue; }
    const ext = imageType(buf);
    if (!ext) { skipped.push(`${a?.name ?? `file ${i + 1}`}: not a PNG, JPEG, GIF or WebP image`); continue; }
    files.push({ name: safeName(a?.name, ext, i), buf });
  }
  return { files, skipped };
}

// writes into <workspace>/attachments/<stamp>/ (a folder per message, so a
// later message never overwrites an earlier one); paths are as the agent sees them
export function saveAttachments(workspace, list, { stamp = new Date().toISOString().replace(/[:.]/g, '-'), uid = 1001 } = {}) {
  const { files, skipped } = decodeAttachments(list);
  if (!files.length) return { paths: [], skipped };
  const rel = `attachments/${stamp}`, abs = `${workspace}/${rel}`;
  mkdirSync(abs, { recursive: true });
  const own = (p) => { try { chownSync(p, uid, uid); } catch {} };
  own(workspace); own(`${workspace}/attachments`); own(abs);
  const paths = files.map((f) => { writeFileSync(`${abs}/${f.name}`, f.buf, { mode: 0o644 }); own(`${abs}/${f.name}`); return `/workspace/${rel}/${f.name}`; });
  return { paths, skipped };
}

// the line added to the person's message, so the agent knows to look
export function attachmentNote({ paths, skipped }) {
  const out = [];
  if (paths.length) out.push(`[The person attached ${paths.length === 1 ? 'an image' : `${paths.length} images`}. Open ${paths.length === 1 ? 'it' : 'each'} with the Read tool before you act; it is part of the request:\n${paths.map((p) => `- ${p}`).join('\n')}]`);
  if (skipped.length) out.push(`[Attachments not saved: ${skipped.join('; ')}]`);
  return out.length ? `\n\n${out.join('\n')}` : '';
}

export const withAttachments = (text, workspace, list, opts) => (Array.isArray(list) && list.length ? String(text ?? '') + attachmentNote(saveAttachments(workspace, list, opts)) : String(text ?? ''));
