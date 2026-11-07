// What the review and QA panels read besides the diff: the proof the agent and
// the factory posted on the PR (runs, screenshots' captions, QA/review reports),
// and the agent's reply to the last review. Pure: no I/O.
export const EVIDENCE_COMMENTS = 10, EVIDENCE_COMMENT_CHARS = 3000, EVIDENCE_REPLY_CHARS = 4000;

const isBot = (c) => c?.user?.type === 'Bot' || /\[bot\]$/i.test(c?.user?.login ?? '');
// the media comment keeps its text; images and videos (markdown, <img>, <video>) go
const stripMedia = (s) => s
  .replace(/<video[\s\S]*?<\/video>/gi, '').replace(/<img\b[^>]*>/gi, '')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/^\s*https?:\/\/\S+\.(?:png|jpe?g|gif|webp|mp4|webm)\s*$/gim, '')
  .replace(/\n{3,}/g, '\n\n').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n[…cut, ${s.length - n} more characters]` : s);

// comments: GitHub issue comments, oldest first. → the last `limit` by a bot, oldest first.
export function pickComments(comments, { limit = EVIDENCE_COMMENTS, chars = EVIDENCE_COMMENT_CHARS } = {}) {
  return (comments ?? []).filter((c) => isBot(c) && typeof c.body === 'string')
    .sort((a, b) => Date.parse(a.created_at ?? 0) - Date.parse(b.created_at ?? 0))
    .slice(-limit)
    .map((c) => ({ at: c.created_at, who: c.user?.login, text: clip(stripMedia(c.body), chars) }))
    .filter((c) => c.text);
}

// msgs: the task's messages, oldest first ({from, text}). The agent's first message after
// the last review/QA findings; null when the agent has not answered yet.
export function replyToLastReview(msgs, { chars = EVIDENCE_REPLY_CHARS, kinds = ['review', 'qa'] } = {}) {
  const i = (msgs ?? []).findLastIndex((m) => kinds.includes(m.from));
  if (i < 0) return null;
  const r = msgs.slice(i + 1).find((m) => m.from === 'agent' && m.text?.trim());
  return r ? clip(r.text.trim(), chars) : null;
}

// the section for the panel prompt; '' when there is nothing to show
// the agent's expectation → proof mapping (parsed from its newest message, so a clipped reply cannot lose it)
// and the media files that really exist: the panel checks one against the other
export function mappingSection(mapping, files) {
  if (!mapping && !(files ?? []).length) return '';
  const list = (files ?? []).map((f) => `${f.sub}/${f.rel}`);
  return `\n--- THE AGENT'S EXPECTATION → PROOF MAPPING (its claim; check each line against the files below and the tests in the diff)
${mapping ? mapping.map((e) => `- ${e.expected} | ${e.kind === 'none' ? 'not shown' : `${e.kind} ${e.ref}`}`).join('\n') : 'none given'}
--- MEDIA FILES THAT EXIST (workspace/screens, workspace/videos)
${list.length ? list.join('\n') : 'none'}\n`;
}
export function evidenceSection(comments, msgs, { kinds, mapping, files } = {}) {
  const picked = pickComments(comments), reply = replyToLastReview(msgs, { kinds }), map = mappingSection(mapping, files);
  if (!picked.length && !reply && !map) return '';
  return `\nEVIDENCE POSTED BY THE AGENT AND THE FACTORY (claims to check against the diff and the preview, not facts to trust):
${picked.map((c) => `--- PR comment by ${c.who} at ${c.at}\n${c.text}`).join('\n\n')}${reply ? `${picked.length ? '\n\n' : ''}--- THE AGENT'S REPLY to the last review/QA findings\n${reply}` : ''}${map}\n`;
}
