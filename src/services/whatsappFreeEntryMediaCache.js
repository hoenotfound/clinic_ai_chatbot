"use strict";

// Per-client Render instance. Promo image IDs are immutable rows; each read
// still checks purpose/MIME in Postgres before reusing an uploaded Meta ID.
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 32;
const cache = new Map();

function key(id) {
  const number = Number(id);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
function get(id, mimeType, now = Date.now()) {
  const k = key(id);
  const item = k === null ? null : cache.get(k);
  if (!item) return null;
  if (item.expiresAt <= now || item.mimeType !== mimeType) {
    cache.delete(k);
    return null;
  }
  return item.mediaId;
}
function put(id, mimeType, mediaId, now = Date.now()) {
  const k = key(id);
  if (k === null || !["image/jpeg","image/png"].includes(mimeType) ||
      !/^\d+$/.test(String(mediaId || ""))) return false;
  cache.delete(k);
  cache.set(k, { mimeType, mediaId: String(mediaId), expiresAt: now + TTL_MS });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return true;
}
function forget(id) {
  const k = key(id);
  if (k !== null) cache.delete(k);
}
function clear() { cache.clear(); }
module.exports = { get, put, forget, clear, TTL_MS };
