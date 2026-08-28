const test = require("node:test");
const assert = require("node:assert/strict");

const { enqueueConversation } = require("../src/utils/conversationQueue");

test("runs work for one conversation in arrival order", async () => {
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = enqueueConversation("6011", async () => {
    order.push("first-start");
    await firstGate;
    order.push("first-end");
  });
  const second = enqueueConversation("6011", async () => {
    order.push("second");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first-start"]);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
});

test("a failed task does not block the next message", async () => {
  const order = [];
  const failed = enqueueConversation("6012", async () => {
    order.push("failed");
    throw new Error("expected test failure");
  });
  const next = enqueueConversation("6012", async () => {
    order.push("next");
  });

  await assert.rejects(failed, /expected test failure/);
  await next;
  assert.deepEqual(order, ["failed", "next"]);
});
