// Unasked questions: an agent turn that ends by asking the person to decide
// something in plain text, without the DECISION NEEDED block. The factory would
// carry on and a reviewer might settle it. One cheap model check per turn finds
// those. The model call is injected, so this is pure: `node agents/test-unasked.mjs`.

export const hasDecisionBlock = (text) => /^\s*DECISION NEEDED\b/m.test(text ?? '');

export function unaskedPrompt(reply, { autoGo = false } = {}) {
  return `Below is the final message of an AI coding agent that worked unattended for a person.

"""
${String(reply).slice(-6000)}
"""

Does this message ask the person to decide, choose, confirm or answer something that the agent did not settle itself (for example "Two things need your call", "should we...?", "which do you prefer", "needs a person to decide")? A plain report of what was done, with notes or decisions the agent already took, is NOT a question. A "what to look at" list for a reviewer is NOT a question. Checks that can only be done after the change merges or deploys (on staging, against real data, by someone with access) are NOT a question either: they are follow-ups. A question written for someone else (for example the reporter of a bug, in a triage reply) is NOT a question to the person.${autoGo ? ' The person runs the factory on auto-go: an open question where the agent says what it suggests, recommends or will assume is the agent\'s own decision, NOT a question to the person. Answer true only when the agent cannot go on without the person: an architecture, design-taste, money or security choice it gives no recommendation for, or something only the person can do (grant a permission, create an account, provide a secret).' : ''}

If it asks, say what KIND of question it is:
- "fact": the answer can be found by running or reading something (does it build, is it slow, what does the code or the API do, which version is installed);
- "reversible": a product, design or engineering choice that can be changed later, and the agent recommends or suggests an option;
- "blocking": the agent cannot go on without the person: something irreversible or that only the person can do (rotate or provide a secret, grant a permission, create an account, spend money, deploy to production, delete data, message users), or a choice where the agent gives no recommendation.

Answer with ONE line of JSON and nothing else: {"asks": true or false, "kind": "fact" | "reversible" | "blocking", "question": "<the question in one or two sentences>", "options": ["<each option the agent offered, short>"], "chosen": "<for reversible: the option the agent recommends or would take, word for word from options; else empty>"}. Use "question": "", "options": [] and "chosen": "" when asks is false.`;
}

export function parseUnasked(out) {
  const j = /\{[\s\S]*\}/.exec(String(out ?? ''));
  let a; try { a = JSON.parse(j?.[0] ?? ''); } catch { return null; }
  if (typeof a?.asks !== 'boolean') return null;
  const question = String(a.question ?? '').trim().slice(0, 600);
  const options = (Array.isArray(a.options) ? a.options : []).map((o) => String(o).trim().slice(0, 300)).filter(Boolean).slice(0, 6);
  if (!(a.asks && question)) return { asks: false };
  // a reversible call needs the agent's own pick; without one, or with an unknown kind, it is blocking (the safe side)
  const chosen = String(a.chosen ?? '').trim().slice(0, 300);
  const kind = a.kind === 'fact' ? 'fact' : a.kind === 'reversible' && chosen ? 'reversible' : 'blocking';
  return { asks: true, kind, question, options, ...(kind === 'reversible' ? { chosen, options: options.includes(chosen) ? options : [chosen, ...options].slice(0, 6) } : {}) };
}

// ask(prompt) -> string (the model's answer). Fails open: any error, timeout or
// unreadable answer means "no question found" and the factory continues as before.
// classifyBlocks: also read a reply that has a DECISION NEEDED block (on auto-go, a block
// for a reversible call is not a stop either); without it, a block is left to the lifecycle as before
export async function checkUnasked(reply, { ask, timeoutMs = 60000, log = () => {}, autoGo = false, classifyBlocks = false } = {}) {
  if (!reply?.trim() || (hasDecisionBlock(reply) && !classifyBlocks)) return { asks: false };
  let timer;
  try {
    const out = await Promise.race([ask(unaskedPrompt(reply, { autoGo })), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs); })]);
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
// the non-blocking notice for a reversible call the factory let the agent take
export function decidedMessage(q) {
  const others = q.options.filter((o) => o !== q.chosen);
  return `[factory] 📌 Decided for you (reversible): ${q.question}\nTaken: ${q.chosen}${others.length ? `\nOther options: ${others.join(' · ')}` : ''}\nThe work goes on with this. To change it, press another option or reply here.`;
}
// a reply that is just an option number ("2", "2.", "option 2") becomes that option's text
export function expandNumberAnswer(text, options) {
  const m = /^\s*(?:option\s*)?(\d{1,2})\s*[.)]?\s*$/i.exec(String(text ?? ''));
  if (!m || !Array.isArray(options)) return text;
  const o = options[Number(m[1]) - 1];
  return o ? `${text.trim()}: ${o}` : text;
}
export const waitingOnLine = (q) => `your answer to: ${q.question.replace(/\s+/g, ' ').slice(0, 160)}`;
