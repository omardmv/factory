// node agents/test-attachments.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { imageType, safeName, decodeAttachments, saveAttachments, attachmentNote, withAttachments, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from './attachments.mjs';

let n = 0; const ok = (name) => console.log(`ok ${++n} - ${name}`);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(32, 3)]);
const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(32, 4)]);
const b64 = (b) => b.toString('base64');

assert.deepEqual([png, jpg, gif, webp, Buffer.from('<html>login</html>')].map(imageType), ['png', 'jpg', 'gif', 'webp', null]);
ok('the type comes from the bytes: png, jpeg, gif, webp; an HTML page (a Slack login redirect) is not an image');

assert.equal(safeName('Screenshot 2026-11-08 at 10.41.22.png', 'png', 0), '01-Screenshot-2026-11-08-at-10-41-22.png');
assert.equal(safeName('../../etc/passwd', 'jpg', 2), '03-etc-passwd.jpg');
assert.equal(safeName('', 'webp', 0), '01-image.webp');
assert.equal(safeName('photo.png', 'jpg', 0), '01-photo.jpg');
ok('names are safe on disk: no path parts, numbered, extension from the real type');

const d = decodeAttachments([{ name: 'a.png', data: b64(png) }, { name: 'evil.png', data: b64(Buffer.from('<html>')) }, { name: 'empty.png', data: '' }, { name: 'big.png', data: b64(Buffer.concat([png, Buffer.alloc(MAX_ATTACHMENT_BYTES)])) }]);
assert.equal(d.files.length, 1);
assert.deepEqual(d.skipped.map((s) => s.split(':')[0]), ['evil.png', 'empty.png', 'big.png']);
assert.match(d.skipped[0], /not a PNG, JPEG, GIF or WebP/); assert.match(d.skipped[2], /over 10 MB/);
ok('a non-image, an empty file and one over 10 MB are skipped with a reason, the good one kept');

const many = decodeAttachments(Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, i) => ({ name: `s${i}.png`, data: b64(png) })));
assert.equal(many.files.length, MAX_ATTACHMENTS); assert.equal(many.skipped.length, 2);
ok(`at most ${MAX_ATTACHMENTS} images per message`);

const ws = mkdtempSync(`${tmpdir()}/att-`);
const r = saveAttachments(ws, [{ name: 'button.png', data: b64(png) }, { name: 'x.jpg', data: b64(jpg) }], { stamp: 's1', uid: process.getuid() });
assert.deepEqual(r.paths, ['/workspace/attachments/s1/01-button.png', '/workspace/attachments/s1/02-x.jpg']);
assert.deepEqual(readFileSync(`${ws}/attachments/s1/01-button.png`), png);
saveAttachments(ws, [{ name: 'button.png', data: b64(gif) }], { stamp: 's2', uid: process.getuid() });
assert.deepEqual(readFileSync(`${ws}/attachments/s1/01-button.png`), png, 'a later message does not overwrite');
ok('saved under the workspace, one folder per message, paths as the agent sees them');

const note = attachmentNote(r);
assert.match(note, /attached 2 images/); assert.match(note, /Read tool/); assert.match(note, /- \/workspace\/attachments\/s1\/02-x\.jpg/);
assert.match(attachmentNote({ paths: [], skipped: ['evil.png: not a PNG, JPEG, GIF or WebP image'] }), /not saved: evil\.png/);
assert.equal(attachmentNote({ paths: [], skipped: [] }), '');
ok('the note tells the agent to open each image, and says which were not saved');

const ws2 = mkdtempSync(`${tmpdir()}/att-`);
assert.equal(withAttachments('make it red', ws2, undefined), 'make it red');
assert.equal(withAttachments('make it red', ws2, []), 'make it red');
assert.ok(!existsSync(`${ws2}/attachments`));
assert.match(withAttachments('make it red', ws2, [{ name: 'p.webp', data: b64(webp) }], { stamp: 's', uid: process.getuid() }), /^make it red\n\n\[The person attached an image\.[\s\S]*01-p\.webp/);
ok('no attachments: the text is unchanged and nothing is written; with one, the note follows the text');

console.log(`all ${n} passed`);
