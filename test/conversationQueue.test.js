const test = require("node:test");
const assert = require("node:assert/strict");

const {
  enqueueConversation,
  enqueueConversationBurst,
} = require("../src/utils/conversationQueue");

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

test("rapid inbound items are delivered to one ordered burst task", async () => {
  const batches = [];
  const batchTask = async (items) => {
    batches.push(items.slice());
    return items.join("|");
  };

  const first = enqueueConversationBurst("burst-1", "hi", batchTask, { delayMs: 10 });
  const second = enqueueConversationBurst("burst-1", "how much hifu", batchTask, { delayMs: 10 });
  const third = enqueueConversationBurst("burst-1", "for double chin", batchTask, { delayMs: 10 });

  const results = await Promise.all([first, second, third]);
  assert.deepEqual(batches, [["hi", "how much hifu", "for double chin"]]);
  assert.deepEqual(results, [
    "hi|how much hifu|for double chin",
    "hi|how much hifu|for double chin",
    "hi|how much hifu|for double chin",
  ]);
});

test("a later burst cannot overtake work already running for the conversation", async () => {
  const order = [];
  let releaseFirst;
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = enqueueConversationBurst(
    "burst-2",
    "one",
    async (items) => {
      order.push(`start:${items.join(",")}`);
      await gate;
      order.push("finish:first");
    },
    { delayMs: 0 }
  );

  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = enqueueConversationBurst(
    "burst-2",
    "two",
    async (items) => {
      order.push(`second:${items.join(",")}`);
    },
    { delayMs: 0 }
  );

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ["start:one"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["start:one", "finish:first", "second:two"]);
});

test("new inbound claim work does not wait behind a slow AI burst", async () => {
  const order = [];
  let releaseReply;
  const replyGate = new Promise((resolve) => {
    releaseReply = resolve;
  });

  const reply = enqueueConversationBurst(
    "burst-claim-lane",
    "older-message",
    async () => {
      order.push("reply-start");
      await replyGate;
      order.push("reply-finish");
    },
    { delayMs: 0 }
  );

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ["reply-start"]);

  const claim = enqueueConversation("burst-claim-lane", async () => {
    order.push("new-message-durably-claimed");
  });
  await claim;

  assert.deepEqual(order, ["reply-start", "new-message-durably-claimed"]);
  releaseReply();
  await reply;
  assert.deepEqual(order, [
    "reply-start",
    "new-message-durably-claimed",
    "reply-finish",
  ]);
});
