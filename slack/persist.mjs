// Coalesce state writes. The bot called persist() (a synchronous write of the
// whole state.json) after every task it touched in a tick; as the state grows
// with every task, that blocked the event loop for the whole tick. save() now
// marks the state dirty and one write happens `delay` ms later, however many
// saves came in; flush() writes at once (used on exit so nothing is lost).
export function makeSaver(write, { delay = 200, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null;
  const flush = () => { if (timer) { clearTimer(timer); timer = null; } write(); };
  const save = () => { if (!timer) timer = setTimer(() => { timer = null; write(); }, delay); };
  const pending = () => timer !== null;
  return { save, flush, pending };
}
