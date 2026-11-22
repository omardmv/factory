// Usage: node slack/bench-persist.mjs — cost of the bot's state writes during one push tick over 300 tasks
// (each task: one persist() after its messages are sent, like pushUpdates), per-call vs coalesced.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeSaver } from './persist.mjs';
const file = `${mkdtempSync(`${tmpdir()}/bench-`)}/state.json`;
const state = { sent: {}, taskChannel: {}, channelTask: {}, archived: {}, media: {}, topic: {}, planPosted: {} };
for (let i = 0; i < 300; i++) {
  const id = `2611${i}-abcdef`; state.sent[id] = 40; state.taskChannel[id] = `C${i}`; state.channelTask[`C${i}`] = id; state.topic[id] = 'x'.repeat(80); state.planPosted[id] = true;
  state.media[id] = Array.from({ length: 30 }, (_, k) => `screens/${id}/shot-${k}.png:12345`);
}
console.log('state.json', (JSON.stringify(state).length / 1024).toFixed(0), 'KB');
const write = () => writeFileSync(file, JSON.stringify(state));
const tick = async (persist) => { const t = process.hrtime.bigint(); let worst = 0; for (let i = 0; i < 300; i++) { const s = process.hrtime.bigint(); persist(); await null; worst = Math.max(worst, Number(process.hrtime.bigint() - s) / 1e6); } return [Number(process.hrtime.bigint() - t) / 1e6, worst]; };
for (const [name, mk] of [['per call', () => write], ['coalesced', () => makeSaver(write).save], ['per call', () => write], ['coalesced', () => makeSaver(write).save]]) {
  const [total, worst] = await tick(mk());
  console.log(name.padEnd(10), 'event-loop time in persist() over 300 calls:', total.toFixed(0), 'ms');
}
