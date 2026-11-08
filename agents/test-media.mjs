// node agents/test-media.mjs: mediaFiles lists only real files inside the task workspace.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mediaFiles } from './media.mjs';

const T = mkdtempSync(`${tmpdir()}/media-`);
const png = (p) => writeFileSync(p, 'x');

// a normal workspace lists its screenshots
mkdirSync(`${T}/ok/screens`, { recursive: true }); png(`${T}/ok/screens/a.png`);
assert.deepEqual(mediaFiles(`${T}/ok`).map((f) => f.rel), ['a.png']);

// the agent replaces screens/ with a symlink to a folder outside the workspace: nothing is listed
mkdirSync(`${T}/outside`); png(`${T}/outside/leak.png`);
mkdirSync(`${T}/evil`); symlinkSync(`${T}/outside`, `${T}/evil/screens`);
assert.deepEqual(mediaFiles(`${T}/evil`), []);

// same for videos/, and a file symlink inside a real folder
mkdirSync(`${T}/evil2/screens`, { recursive: true }); symlinkSync(`${T}/outside/leak.png`, `${T}/evil2/screens/b.png`);
symlinkSync(`${T}/outside`, `${T}/evil2/videos`);
assert.deepEqual(mediaFiles(`${T}/evil2`), []);

// no workspace yet
assert.deepEqual(mediaFiles(`${T}/none`), []);
console.log('media ok');
