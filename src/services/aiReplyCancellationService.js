const epochs = new Map();
const epochTouchedAt = new Map();
const pendingEchoes = new Map();

const EPOCH_TTL_MS = 6 * 60 * 60 * 1000;
const EPOCH_PRUNE_INTERVAL_MS = 60 * 1000;
const MAX_EPOCH_KEYS = 5000;
let lastEpochPruneAt = 0;

function pruneEpochs(now = Date.now()) {
  if (
    now - lastEpochPruneAt < EPOCH_PRUNE_INTERVAL_MS &&
    epochs.size <= MAX_EPOCH_KEYS
  ) {
    return;
  }
  lastEpochPruneAt = now;

  for (const [key, touchedAt] of epochTouchedAt.entries()) {
    if (
      !pendingEchoes.has(key) &&
      now - touchedAt > EPOCH_TTL_MS
    ) {
      epochTouchedAt.delete(key);
      epochs.delete(key);
    }
  }

  if (epochs.size <= MAX_EPOCH_KEYS) return;

  const oldest = [...epochTouchedAt.entries()]
    .filter(([key]) => !pendingEchoes.has(key))
    .sort((a, b) => a[1] - b[1]);

  for (const [key] of oldest) {
    if (epochs.size <= MAX_EPOCH_KEYS) break;
    epochTouchedAt.delete(key);
    epochs.delete(key);
  }
}

function enabled() {
  return String(process.env.WHATSAPP_COEXISTENCE_ENABLED || "").trim().toLowerCase() === "true";
}

function keyForWhatsAppNumber(number) {
  const value = String(number || "").replace(/\D/g, "");
  return value ? `whatsapp:${value}` : null;
}

function keyForChannelContact(channel, externalId) {
  const normalizedChannel = String(channel || "").trim().toLowerCase();
  const normalizedId = String(externalId || "").trim();
  if (!normalizedChannel || !normalizedId) return null;
  return `${normalizedChannel}:${normalizedId}`;
}

function keyForContact(contact) {
  const channel = String(contact?.channel || "whatsapp").trim().toLowerCase();
  return channel === "whatsapp"
    ? keyForWhatsAppNumber(contact?.whatsapp_number)
    : keyForChannelContact(channel, contact?.channel_user_id);
}

function cancelForContact(contact) {
  return cancel(keyForContact(contact));
}

function snapshot(key) {
  if (!key) return 0;
  pruneEpochs();
  return epochs.get(String(key)) || 0;
}

function cancel(key) {
  if (!key) return 0;
  const normalized = String(key);
  const next = snapshot(normalized) + 1;
  epochs.set(normalized, next);
  epochTouchedAt.set(normalized, Date.now());
  pruneEpochs();
  return next;
}

function cancelledSince(key, token) {
  return snapshot(key) !== token;
}

function beginPendingEcho(key, echoId) {
  if (!key || !echoId) return false;
  const normalizedKey = String(key);
  const normalizedId = String(echoId);
  let ids = pendingEchoes.get(normalizedKey);
  if (!ids) {
    ids = new Set();
    pendingEchoes.set(normalizedKey, ids);
  }
  const wasNew = !ids.has(normalizedId);
  ids.add(normalizedId);
  return wasNew;
}

function endPendingEcho(key, echoId) {
  if (!key || !echoId) return;
  const normalizedKey = String(key);
  const ids = pendingEchoes.get(normalizedKey);
  if (!ids) return;
  ids.delete(String(echoId));
  if (!ids.size) pendingEchoes.delete(normalizedKey);
}

function hasPendingEcho(key) {
  if (!key) return false;
  return Boolean(pendingEchoes.get(String(key))?.size);
}

function safeToSend(key, token) {
  return !cancelledSince(key, token) && !hasPendingEcho(key);
}

async function settleBeforeSend(
  key,
  token,
  {
    delayMs = 200,
    pendingWaitMs = 1000,
    pollMs = 10,
  } = {}
) {
  if (!key) return true;
  if (cancelledSince(key, token)) return false;
  if (
    String(key).startsWith("whatsapp:") &&
    !enabled() &&
    !hasPendingEcho(key)
  ) {
    return true;
  }

  await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (cancelledSince(key, token)) return false;

  const deadline = Date.now() + pendingWaitMs;
  while (hasPendingEcho(key) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    if (cancelledSince(key, token)) return false;
  }

  // Fail closed if a Business App echo reached this process but its durable
  // dedupe/ownership transaction has not resolved yet.
  return safeToSend(key, token);
}

module.exports = {
  enabled,
  keyForWhatsAppNumber,
  keyForChannelContact,
  keyForContact,
  cancelForContact,
  snapshot,
  cancel,
  cancelledSince,
  beginPendingEcho,
  endPendingEcho,
  hasPendingEcho,
  safeToSend,
  settleBeforeSend,
};