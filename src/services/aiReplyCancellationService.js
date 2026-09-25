const epochs = new Map();
const pendingEchoes = new Map();

function enabled() {
  return String(process.env.WHATSAPP_COEXISTENCE_ENABLED || "").trim().toLowerCase() === "true";
}

function keyForWhatsAppNumber(number) {
  const value = String(number || "").replace(/\D/g, "");
  return value ? `whatsapp:${value}` : null;
}

function snapshot(key) {
  if (!key) return 0;
  return epochs.get(String(key)) || 0;
}

function cancel(key) {
  if (!key) return 0;
  const normalized = String(key);
  const next = snapshot(normalized) + 1;
  epochs.set(normalized, next);
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
  if (!enabled()) return true;
  if (cancelledSince(key, token)) return false;

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
  snapshot,
  cancel,
  cancelledSince,
  beginPendingEcho,
  endPendingEcho,
  hasPendingEcho,
  safeToSend,
  settleBeforeSend,
};
