"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { putBoundedExpiringCache } = require("../src/utils/boundedExpiringCache");

test("metadata cache keeps at most the configured number of entries", () => {
  const cache = new Map();
  for (let i = 0; i < 1000; i++) {
    putBoundedExpiringCache(cache, String(i), { profileName: String(i) }, 60000, 32, 1000);
    assert.ok(cache.size <= 32);
  }
  assert.equal(cache.size, 32);
  assert.equal(cache.has("0"), false);
  assert.equal(cache.has("999"), true);
});

test("metadata cache removes expired records first before evicting active ones", () => {
  const cache = new Map();
  putBoundedExpiringCache(cache, "old", null, 100, 2, 0);
  putBoundedExpiringCache(cache, "valid", { name: "A" }, 5000, 2, 0);
  putBoundedExpiringCache(cache, "new", { name: "B" }, 5000, 2, 1000);
  assert.deepEqual([...cache.keys()], ["valid", "new"]);
});

test("refreshing an existing entry preserves the maximum size and replaces its TTL", () => {
  const cache = new Map();
  putBoundedExpiringCache(cache, "a", null, 5, 1, 0);
  putBoundedExpiringCache(cache, "a", { name: "A" }, 50, 1, 10);
  assert.equal(cache.size, 1);
  assert.deepEqual(cache.get("a"), { value: { name: "A" }, expiresAt: 60 });
});

test("invalid bounds fail closed", () => {
  assert.throws(() => putBoundedExpiringCache(new Map(), "a", {}, 10, 0), TypeError);
  assert.throws(() => putBoundedExpiringCache(new Map(), "a", {}, 0, 4), TypeError);
});
