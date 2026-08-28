// WhatsApp may deliver two webhook requests for the same customer at nearly
// the same time. Keep each customer's work in arrival order while still
// allowing different customers to be processed in parallel.
const queues = new Map();

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

module.exports = { enqueueConversation };
