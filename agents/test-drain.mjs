// node agents/test-drain.mjs
import assert from 'node:assert/strict';
import { drainDecision, drainRecord, startupPlan, createDrain, DRAIN_TIMEOUT_MS } from './drain.mjs';

let n = 0;
const test = async (name, f) => { await f(); n++; console.log('ok', name); };
const rig = (ids) => {
  const s = { ids: [...ids], t: 0, exited: 0, killed: [], rec: null };
  const d = createDrain({ running: () => s.ids, now: () => s.t, killAll: (x) => { s.killed = x; }, writeRecord: (r) => { s.rec = r; }, exit: () => { s.exited++; } });
  return { s, d };
};

await test('no jobs: exits at once, writes nothing', () => {
  const { s, d } = rig([]);
  d.start();
  assert.equal(s.exited, 1); assert.equal(s.rec, null); assert.deepEqual(s.killed, []);
});
await test('a running job: waits, then exits when it finishes', () => {
  const { s, d } = rig(['a']);
  d.start(); assert.equal(s.exited, 0);
  s.t = 20 * 60000; d.tick(); assert.equal(s.exited, 0);
  s.ids = []; s.t += 1000; d.tick();
  assert.equal(s.exited, 1); assert.equal(s.rec, null); assert.deepEqual(s.killed, []);
});
await test('timeout: reports the cut-off tasks, kills them, exits', () => {
  const { s, d } = rig(['a', 'b']);
  d.start();
  s.t = DRAIN_TIMEOUT_MS - 1; d.tick(); assert.equal(s.exited, 0);
  s.ids = ['b']; s.t = DRAIN_TIMEOUT_MS; d.tick();
  assert.equal(s.exited, 1); assert.deepEqual(s.killed, ['b']);
  assert.deepEqual(s.rec.cutOff, [{ id: 'b' }]); assert.equal(s.rec.timeoutMin, 30);
});
await test('not draining: tick does nothing', () => {
  const { s, d } = rig(['a']);
  assert.equal(d.tick(), null); assert.equal(d.draining, false); assert.equal(s.exited, 0);
});
await test('startup: cut-off tasks are re-queued and announced', () => {
  const rec = drainRecord({ cutOff: [{ id: 'a', kind: 'agent' }, { id: 'b' }, { id: 'c' }], at: 0 });
  const p = startupPlan(rec, { a: { job: { kind: 'agent' }, status: 'working' }, b: { job: { kind: 'review' }, status: 'reviewing' }, c: { job: { kind: 'agent' }, status: 'stopped' } });
  assert.deepEqual(p.requeue, ['a', 'b']);
  assert.equal(p.notices.length, 3);
  assert.match(p.notices[0].text, /queued again/); assert.match(p.notices[2].text, /stays so/);
});
await test('startup: no drain.json means nothing to do', () => {
  assert.deepEqual(startupPlan(null, {}), { requeue: [], notices: [] });
});

// a real process: SIGTERM arrives while a "turn" (a child process) runs; the process exits only after it finished
await test('real SIGTERM during a running turn: the turn finishes, then the process exits 0', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const mod = fileURLToPath(new URL('./drain.mjs', import.meta.url));
  const code = `
    import { createDrain } from ${JSON.stringify(mod)};
    import { spawn } from 'node:child_process';
    const running = new Map();
    const turn = spawn('node', ['-e', 'setTimeout(()=>{console.log("turn finished");},1500)'], { stdio: 'inherit' });
    running.set('t1', turn); turn.on('close', () => running.delete('t1'));
    const d = createDrain({ running: () => [...running.keys()], now: Date.now, killAll() {}, writeRecord() { console.log('RECORD'); }, exit: () => { console.log('exit'); process.exit(0); } });
    process.on('SIGTERM', () => d.start());
    setInterval(() => d.tick(), 100);
    console.log('ready');`;
  const p = spawn('node', ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = ''; p.stdout.on('data', (c) => { out += c; if (/ready/.test(out) && !p.killed && !out.includes('termed')) { out += 'termed'; setTimeout(() => p.kill('SIGTERM'), 300); } });
  const exit = await new Promise((r) => p.on('close', r));
  assert.equal(exit, 0);
  assert.ok(out.indexOf('turn finished') >= 0 && out.indexOf('turn finished') < out.indexOf('exit'), out);
  assert.ok(!out.includes('RECORD'));
});
console.log(`${n} passed`);
