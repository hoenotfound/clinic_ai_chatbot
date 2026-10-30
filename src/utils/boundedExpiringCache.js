"use strict";

// Keep expiring external API metadata caches from retaining every customer or
// comment ever seen. Entries contain no message history or media bytes.
function putBoundedExpiringCache(cache, key, value, ttlMs, maxEntries, now = Date.now()) {
  if (!(cache instanceof Map)) throw new TypeError("cache must be a Map");
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError("maxEntries must be a positive integer");
  }
  const ttl = Number(ttlMs);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new TypeError("ttlMs must be positive");
  }
  cache.delete(key);
  cache.set(key, { value, expiresAt: now + ttl });
  if (cache.size <= maxEntries) return;

  // Expired entries may otherwise persist indefinitely when never looked up.
  for (const [entryKey, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(entryKey);
  }
  // Map insertion order supplies a simple oldest-entry eviction policy.
  while (cache.size > maxEntries) {
    cache.delete(cache.keys().next().value);
  }
}

module.exports = { putBoundedExpiringCache };
