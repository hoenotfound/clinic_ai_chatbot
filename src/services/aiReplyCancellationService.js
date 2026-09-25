const epochs = new Map();

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

async function settleBeforeSend(key, token, delayMs = 200) {
  if (!enabled()) return true;
  if (cancelledSince(key, token)) return false;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return !cancelledSince(key, token);
}

module.exports = {
  enabled,
  keyForWhatsAppNumber,
  snapshot,
  cancel,
  cancelledSince,
  settleBeforeSend,
};
