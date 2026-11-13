// node agents/test-readdb.mjs
import assert from 'node:assert/strict';
import { readDbConfig, readDbEnv, readDbFor, readDbRules, redact, ENV_KEYS } from './readdb.mjs';

let n = 0;
const test = (name, f) => { f(); n++; console.log('ok', name); };
const good = { host: 'db.internal', port: 5432, name: 'shop', user: 'agent_ro', passwordFile: 'shop-readdb' };
const PW = ['pw', 'S3cret', 'value'].join('-'); // built at runtime: a fake value, kept out of secret scanners
const sec = (name) => { if (name !== 'shop-readdb') throw new Error('nope'); return PW; };

test('default off: no readDb means no env, no rules', () => {
  for (const p of [undefined, {}, { readDb: null }, { readDb: false }]) { assert.equal(readDbConfig(p), null); assert.deepEqual(readDbEnv(p, sec), {}); }
  assert.equal(readDbRules({}), '');
});
test('configured: env carries the connection and a read-only session', () => {
  const env = readDbEnv({ readDb: good }, sec);
  assert.equal(env.PGHOST, 'db.internal'); assert.equal(env.PGUSER, 'agent_ro'); assert.equal(env.PGPASSWORD, PW);
  assert.equal(env.PGSSLMODE, 'require'); assert.match(env.PGOPTIONS, /default_transaction_read_only=on/);
  for (const k of Object.keys(env)) assert.ok(ENV_KEYS.includes(k));
  assert.match(readDbRules(env), /only read/);
});
test('rejects write-capable or unknown settings', () => {
  for (const bad of [{ ...good, user: 'postgres' }, { ...good, user: 'shop_admin' }, { ...good, user: 'app_rw' }, { ...good, allowWrite: true }, { ...good, host: '' }, { ...good, port: 0 }, { ...good, name: 'a b' }, { ...good, passwordFile: '../etc/passwd' }, { ...good, passwordFile: '/abs' }, { ...good, sslmode: 'disable' }, 'x', []]) {
    const r = readDbConfig({ readDb: bad }); assert.equal(r.ok, false, JSON.stringify(bad));
    assert.deepEqual(readDbEnv({ readDb: bad }, sec), {});
  }
});
test('fails closed when the password cannot be read or is empty', () => {
  assert.deepEqual(readDbEnv({ readDb: good }, () => { throw new Error('missing'); }), {});
  assert.deepEqual(readDbEnv({ readDb: good }, () => ''), {});
});
test('the password is scrubbed from text', () => {
  const env = readDbEnv({ readDb: good }, sec);
  assert.equal(redact(`connect with ${PW} ok`, env), 'connect with [redacted] ok');
  assert.equal(redact('plain', {}), 'plain');
});
test('only the working agent gets the env; reviewers, QA and others get none', () => {
  const p = { readDb: good };
  assert.equal(readDbFor('work', p, sec).PGPASSWORD, PW);
  for (const role of ['review', 'qa', 'doctor', 'coordinator', undefined, '']) assert.deepEqual(readDbFor(role, p, sec), {});
});
test('a password with quotes or backslashes is masked in its JSON-escaped form, and before any cut', () => {
  const odd = 'p"w\\x\ty-9z'; const env = { PGPASSWORD: odd };
  const logged = JSON.stringify({ command: `PGPASSWORD=${odd} psql` });
  assert.ok(!redact(logged, env).includes(JSON.stringify(odd).slice(1, -1)));
  const long = JSON.stringify({ command: 'x'.repeat(290) + PW + ' psql' });
  const cut = redact(long, { PGPASSWORD: PW }).slice(0, 300);
  assert.ok(!cut.includes('pw-S3') && !cut.includes('S3cret'));
});
console.log(`${n} passed`);
