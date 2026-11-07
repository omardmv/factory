// Unasked questions: an agent turn that ends by asking the person to decide
// something in plain text, without the DECISION NEEDED block. The factory would
// carry on and a reviewer might settle it. One cheap model check per turn finds
// those. The model call is injected, so this is pure: `node agents/test-unasked.mjs`.

export const hasDecisionBlock = (text) => /^\s*DECISION NEEDED\b/m.test(text ?? '');

export function unaskedPrompt(reply) {
  return `Below is the final message of an AI coding agent that worked unattended for a person.

"""
${String(reply).slice(-6000)}
"""

Does this message ask the person to decide, choose, confirm or answer something that the agent did not settle itself (for example "Two things need your call", "should we...?", "which do you prefer", "needs a person to decide")? A plain report of what was done, with notes or decisions the agent already took, is NOT a question. A "what to look at" list for a reviewer is NOT a question.

Answer with ONE line of JSON and nothing else: {"asks": true or false, "question": "<the question in one or two sentences>", "options": ["<each option the agent offered, short>"]}. Use "question": "" and "options": [] when asks is false.`;
}

export function parseUnasked(out) {
  const j = /\{[\s\S]*\}/.exec(String(out ?? ''));
  let a; try { a = JSON.parse(j?.[0] ?? ''); } catch { return null; }
  if (typeof a?.asks !== 'boolean') return null;
  const question = String(a.question ?? '').trim().slice(0, 600);
  const options = (Array.isArray(a.options) ? a.options : []).map((o) => String(o).trim().slice(0, 300)).filter(Boolean).slice(0, 6);
  return a.asks && question ? { asks: true, question, options } : { asks: false };
}

// ask(prompt) -> string (the model's answer). Fails open: any error, timeout or
// unreadable answer means "no question found" and the factory continues as before.
export async function checkUnasked(reply, { ask, timeoutMs = 60000, log = () => {} } = {}) {
  if (!reply?.trim() || hasDecisionBlock(reply)) return { asks: false };
  let timer;
  try {
    const out = await Promise.race([ask(unaskedPrompt(reply)), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs); })]);
    const r = parseUnasked(out);
    if (!r) { log('unasked.unreadable', { out: String(out ?? '').slice(0, 200) }); return { asks: false }; }
    return r;
  } catch (e) { log('unasked.failed', { error: e.message }); return { asks: false }; }
  finally { clearTimeout(timer); }
}

// the decision as the message the person sees (dashboard and Slack both treat a
// message starting with DECISION NEEDED as a decision) and the one-line waitingOn
export function decisionMessage(q) {
  return `DECISION NEEDED\nThe agent asked this in plain text without stopping for you, so the factory paused it:\n\n${q.question}${q.options.length ? `\n\nThe agent's options:\n${q.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}` : ''}\n\nReply with your choice; it goes back to the agent as a normal message.`;
}
export const waitingOnLine = (q) => `your answer to: ${q.question.replace(/\s+/g, ' ').slice(0, 160)}`;
