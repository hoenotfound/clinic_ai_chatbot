// Keep each customer's work in arrival order while still allowing different
// customers to process in parallel. A second layer groups rapid-fire inbound
// messages so "hi" + "how much hifu" + "for double chin" becomes one AI turn.
const queues = new Map();
const bursts = new Map();

const DEFAULT_BURST_DELAY_MS = 1200;
const MAX_BURST_DELAY_MS = 3000;
const MAX_BURST_ITEMS = 20;

function enqueueConversation(key, task) {
  const queueKey = String(key || "unknown");
  const previous = queues.get(queueKey) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);

  queues.set(queueKey, current);
  current
    .finally(() => {
      if (queues.get(queueKey) === current) queues.delete(queueKey);
    })
    .catch(() => {});

  return current;
}

function normalizeDelay(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_BURST_DELAY_MS;
  return Math.min(Math.round(parsed), MAX_BURST_DELAY_MS);
}

function flushBurst(queueKey, entry) {
  if (bursts.get(queueKey) !== entry) return;
  bursts.delete(queueKey);
  clearTimeout(entry.timer);

  const items = entry.items.splice(0);
  const waiters = entry.waiters.splice(0);
  const work = enqueueConversation(queueKey, () => entry.batchTask(items));
  work.then(
    (value) => waiters.forEach(({ resolve }) => resolve(value)),
    (err) => waiters.forEach(({ reject }) => reject(err))
  );
}

/**
 * Collects individual inbound payloads arriving within a short quiet window,
 * then hands the whole ordered batch to one task. The batch task is still run
 * through enqueueConversation, so a second burst cannot overtake the first.
 */
function enqueueConversationBurst(
  key,
  item,
  batchTask,
  { delayMs = process.env.AI_REPLY_DEBOUNCE_MS } = {}
) {
  const queueKey = String(key || "unknown");
  let entry = bursts.get(queueKey);

  if (!entry) {
    entry = {
      items: [],
      waiters: [],
      batchTask,
      timer: null,
    };
    bursts.set(queueKey, entry);
  }

  entry.items.push(item);
  return new Promise((resolve, reject) => {
    entry.waiters.push({ resolve, reject });

    const shouldFlushNow = entry.items.length >= MAX_BURST_ITEMS;
    clearTimeout(entry.timer);
    if (shouldFlushNow) {
      queueMicrotask(() => flushBurst(queueKey, entry));
      return;
    }

    entry.timer = setTimeout(
      () => flushBurst(queueKey, entry),
      normalizeDelay(delayMs)
    );
  });
}

module.exports = {
  DEFAULT_BURST_DELAY_MS,
  MAX_BURST_ITEMS,
  enqueueConversation,
  enqueueConversationBurst,
  normalizeDelay,
};
