// Keep each customer's fast inbound-claim work in arrival order while still
// allowing different customers to process in parallel. Reply processing uses a
// separate per-customer queue so a new webhook can be durably stored even while
// an earlier AI reply is waiting on a provider/network call. A second layer
// groups rapid-fire inbound messages so "hi" + "how much hifu" + "for double
// chin" becomes one AI turn.
const queues = new Map();
const replyQueues = new Map();
const bursts = new Map();

const DEFAULT_BURST_DELAY_MS = 1200;
const MAX_BURST_DELAY_MS = 3000;
const MAX_BURST_ITEMS = 20;

function enqueueOn(queueMap, key, task) {
  const queueKey = String(key || "unknown");
  const previous = queueMap.get(queueKey) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);

  queueMap.set(queueKey, current);
  current
    .finally(() => {
      if (queueMap.get(queueKey) === current) queueMap.delete(queueKey);
    })
    .catch(() => {});

  return current;
}

function enqueueConversation(key, task) {
  return enqueueOn(queues, key, task);
}

/**
 * Explicit alias used when a caller wants to document that this is the short
 * durable webhook-claim lane rather than slow reply processing.
 */
function enqueueConversationClaim(key, task) {
  return enqueueConversation(key, task);
}

function enqueueReplyConversation(key, task) {
  return enqueueOn(replyQueues, key, task);
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
  const work = enqueueReplyConversation(queueKey, () => entry.batchTask(items));
  work.then(
    (value) => waiters.forEach(({ resolve }) => resolve(value)),
    (err) => waiters.forEach(({ reject }) => reject(err))
  );
}

/**
 * Collects individual inbound payloads arriving within a short quiet window,
 * then hands the whole ordered batch to one task. The batch task is serialized
 * on the reply queue, so a second burst cannot overtake the first while the
 * independent inbound-claim queue remains free to persist newer webhooks.
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
  enqueueConversationClaim,
  normalizeDelay,
};
