// node agents/test-evidence.mjs
import assert from 'node:assert/strict';
import { pickComments, replyToLastReview, evidenceSection } from './evidence.mjs';

let n = 0;
const test = (name, f) => { f(); n++; console.log('ok', name); };
const c = (i, o = {}) => ({ created_at: new Date(Date.UTC(2026, 10, 7, 0, i)).toISOString(), user: { login: 'omar-factory[bot]', type: 'Bot' }, body: `comment ${i}`, ...o });

test('keeps the last 10 bot comments, oldest first', () => {
  const r = pickComments(Array.from({ length: 15 }, (_, i) => c(i)));
  assert.equal(r.length, 10); assert.equal(r[0].text, 'comment 5'); assert.equal(r.at(-1).text, 'comment 14');
});
test('orders by time even when the input is shuffled', () => {
  assert.deepEqual(pickComments([c(3), c(1), c(2)]).map((x) => x.text), ['comment 1', 'comment 2', 'comment 3']);
});
test('excludes other authors', () => {
  const r = pickComments([c(1), c(2, { user: { login: 'alice', type: 'User' } }), c(3, { user: { login: 'x[bot]' } })]);
  assert.deepEqual(r.map((x) => x.text), ['comment 1', 'comment 3']);
});
test('the limit counts only bot comments', () => {
  const r = pickComments([c(1), ...Array.from({ length: 12 }, (_, i) => c(i + 2, { user: { login: 'bob', type: 'User' } }))]);
  assert.equal(r.length, 1);
});
test('truncates each comment', () => {
  const r = pickComments([c(1, { body: 'x'.repeat(5000) })], { chars: 100 });
  assert.ok(r[0].text.startsWith('x'.repeat(100))); assert.ok(r[0].text.length < 160); assert.match(r[0].text, /cut, 4900/);
});
test('media comment: text stays, images and videos go', () => {
  const body = '<!-- factory-media -->\n**What the agent saw**\n\n![shot](https://x/a.png)\n<img src="https://x/b.png" width=300>\n<video src="https://x/v.mp4"></video>\nPhone width, empty state';
  const t = pickComments([c(1, { body })])[0].text;
  assert.match(t, /What the agent saw/); assert.match(t, /Phone width, empty state/); assert.doesNotMatch(t, /png|mp4|<img|<video/);
});
test('a comment that is only images is dropped', () => {
  assert.deepEqual(pickComments([c(1, { body: '![a](https://x/a.png)' })]), []);
});
test('reply: the agent message after the last review, not an earlier one', () => {
  const m = [{ from: 'agent', text: 'first' }, { from: 'review', text: 'f1' }, { from: 'agent', text: 'answer 1' }, { from: 'review', text: 'f2' }, { from: 'factory', text: '[factory] x' }, { from: 'agent', text: 'answer 2' }, { from: 'agent', text: 'later' }];
  assert.equal(replyToLastReview(m), 'answer 2');
});
test('reply: null when the agent has not answered the last review, or none exists', () => {
  assert.equal(replyToLastReview([{ from: 'agent', text: 'a' }, { from: 'review', text: 'f' }]), null);
  assert.equal(replyToLastReview([{ from: 'agent', text: 'a' }]), null);
  assert.equal(replyToLastReview([]), null);
});
test('reply: a QA finding counts too, and the reply is truncated', () => {
  assert.match(replyToLastReview([{ from: 'qa', text: 'q' }, { from: 'agent', text: 'y'.repeat(50) }], { chars: 10 }), /^y{10}\n\[…cut/);
});
test('section: empty with nothing, labelled as unverified evidence otherwise', () => {
  assert.equal(evidenceSection([], []), '');
  const s = evidenceSection([c(1)], [{ from: 'review', text: 'f' }, { from: 'agent', text: 'fixed it' }]);
  assert.match(s, /not facts to trust/); assert.match(s, /comment 1/); assert.match(s, /REPLY[^\n]*\nfixed it/);
});
console.log(`${n} passed`);
