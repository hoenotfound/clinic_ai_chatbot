const test = require("node:test");
const assert = require("node:assert/strict");
const load = () => import("../portal-frontend/src/utils/mascotActivity.js");

test("Dashy reacts only to identified activity in the selected conversation", async () => {
  const { classifyMascotEvent } = await load();
  assert.equal(classifyMascotEvent({}, 9), null);
  assert.equal(classifyMascotEvent({ contactId: 9, reason: "message", messageId: 7 }, null), null);
  assert.equal(classifyMascotEvent({ contactId: 8, reason: "message", messageId: 7 }, 9), null);
  assert.equal(classifyMascotEvent({ contactId: 9, reason: "message_mutation", messageId: 7 }, 9), null);
  assert.equal(classifyMascotEvent({ contactId: 9, deliveryStatus: "delivered", messageId: 7 }, 9), null);
  assert.equal(classifyMascotEvent({ contactId: 9, reason: "message", messageId: 7 }, 9).kind, "greeting");
  assert.equal(classifyMascotEvent({ contactId: 9, deliveryStatus: "failed", messageId: 7 }, 9).kind, "alert");
});

test("Dashy avoids repeated events and preserves important reactions", async () => {
  const { nextMascotActivity } = await load();
  const alert = { kind: "alert", contactId: 9, key: "failed:1" };
  const greeting = { kind: "greeting", contactId: 9, key: "message:2" };
  const success = { kind: "success", contactId: 9, key: "booking:3" };
  const a = nextMascotActivity(null, alert, 100);
  assert.equal(a.kind, "alert");
  assert.equal(nextMascotActivity(a, alert, 500), a);
  assert.equal(nextMascotActivity(a, greeting, 500), a);
  assert.equal(nextMascotActivity(a, success, 500), a);
  assert.equal(nextMascotActivity(a, greeting, a.until + 1).kind, "greeting");
  assert.equal(nextMascotActivity(a, { ...greeting, contactId: 10 }, 500).kind, "greeting");
  const s = nextMascotActivity(null, success, 100);
  assert.equal(nextMascotActivity(s, greeting, 500), s);
  assert.equal(nextMascotActivity(s, alert, 500).kind, "alert");
});

test("Dashy deduplicates across intervening events and throttles greeting bursts", async () => {
  const { nextMascotActivity: next } = await load();
  const event = (kind, key, contactId = 9) => ({ kind, key, contactId });
  const a = next(null, event("greeting", "message:1"), 100);
  assert.equal(next(a, event("greeting", "message:2"), 2000), a);
  const b = next(a, event("alert", "failed:3"), 2000);
  assert.equal(next(b, event("greeting", "message:1"), 9000), b);
  const c = next(b, event("greeting", "message:4"), 9000);
  assert.equal(c.kind, "greeting");
  assert.equal(next(c, event("alert", "failed:3"), 10000), c);
  const d = next(c, event("alert", "failed:5", 10), 11000);
  assert.equal(d.kind, "alert");
  assert.equal(next(d, event("greeting", "message:4"), 12000), d);
  assert.equal(next(d, event("alert", "failed:3"), 40000).kind, "alert");
  let state = null;
  for (let i = 0; i < 100; i++) state = next(state, event("alert", "failed:" + i), i);
  assert.equal(state.recent.length, 64);
});
