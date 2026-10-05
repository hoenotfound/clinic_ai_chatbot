const test = require("node:test");
const assert = require("node:assert/strict");
const aiService = require("../src/services/aiService");
const {
  isSubstantiallySimilar,
  previousFollowUps,
  selectPromotionPackageForFollowUp,
  similarity,
  trimConversation,
} = require("../src/services/followUpAiService");

const originalGetReplyWithEnv = aiService.getReplyWithEnv;

test.afterEach(() => {
  aiService.getReplyWithEnv = originalGetReplyWithEnv;
});

test("follow-up context keeps the newest bounded conversation in chronological order", () => {
  const input = Array.from({ length: 25 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `message-${index}`,
  }));
  const trimmed = trimConversation(input, { maxMessages: 5, maxChars: 500 });
  assert.deepEqual(trimmed.map((item) => item.content), [
    "message-20",
    "message-21",
    "message-22",
    "message-23",
    "message-24",
  ]);
});

test("similarity catches near-duplicate Chinese follow-ups", () => {
  const first = "嗨～想跟进一下你刚才问的大小脸问题 😊";
  const second = "嗨 想再跟进一下你刚才问的大小脸问题";
  assert.ok(similarity(first, second) >= 0.72);
  assert.equal(isSubstantiallySimilar(second, [first]), true);
});

test("different useful follow-up angles are not treated as duplicates", () => {
  assert.equal(
    isSubstantiallySimilar(
      "如果你主要在意正面左右不对称，中医师可以先帮你做1对1评估+体验。",
      ["刚才有发你3D小颜术的体验价，有价格方面的问题都可以问我。"]
    ),
    false
  );
});


test("previous automated follow-ups are scoped to the current conversation anchor", () => {
  const messages = [
    {
      role: "assistant",
      content: "Old sequence follow-up",
      is_automated_follow_up: true,
      automated_follow_up_for_message_id: 10,
    },
    {
      role: "assistant",
      content: "Current sequence follow-up",
      is_automated_follow_up: true,
      automated_follow_up_for_message_id: 20,
    },
  ];

  assert.deepEqual(previousFollowUps(messages, 20), ["Current sequence follow-up"]);
});


test("promotion package selector uses customer messages only and returns an exact configured package key", async () => {
  let received = null;
  aiService.getReplyWithEnv = async (messages, options) => {
    received = { messages, options };
    return JSON.stringify({
      action: "send",
      message: "Package A",
      reason: "Customer specifically wants the meridian massage inclusion.",
      topic: "Package A",
    });
  };

  const selected = await selectPromotionPackageForFollowUp({
    conversation: [
      { role: "user", content: "我比较想要有经络按摩的配套" },
      { role: "assistant", content: "Package B is the last package I mentioned." },
    ],
    serviceName: "Pelvic Care",
    packages: [
      {
        name: "Package A",
        title: "Premium package",
        aliases: ["A配套"],
        caption: "Includes 经络穴位按摩",
        followUpMessage: "SECRET RM388",
      },
      {
        name: "Package B",
        title: "Women's package",
        aliases: ["B配套"],
        caption: "Includes 子宫护理",
        followUpMessage: "SECRET RM288",
      },
    ],
    channel: "whatsapp",
  });

  assert.equal(selected, "Package A");
  assert.match(received.messages[0].content, /我比较想要有经络按摩的配套/);
  assert.doesNotMatch(received.messages[0].content, /Package B is the last package/);
  assert.equal(received.options.surface, "follow_up");
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      received.options.followUpContext.packageSelection.packages[0],
      "followUpMessage"
    ),
    false
  );
});

test("promotion package selector fails closed when the model does not return one exact canonical package", async () => {
  aiService.getReplyWithEnv = async () =>
    JSON.stringify({
      action: "send",
      message: "A配套",
      reason: "Alias instead of canonical package name.",
      topic: "A配套",
    });

  const selected = await selectPromotionPackageForFollowUp({
    conversation: [{ role: "user", content: "骨盆配套多少钱？" }],
    serviceName: "Pelvic Care",
    packages: [
      { name: "Package A", aliases: ["A配套"], caption: "A" },
      { name: "Package B", aliases: ["B配套"], caption: "B" },
    ],
  });

  assert.equal(selected, null);
});

test("promotion package selector skips AI entirely without customer evidence", async () => {
  let calls = 0;
  aiService.getReplyWithEnv = async () => {
    calls += 1;
    return "";
  };

  const selected = await selectPromotionPackageForFollowUp({
    conversation: [{ role: "assistant", content: "Package A and Package B" }],
    serviceName: "Pelvic Care",
    packages: [
      { name: "Package A", caption: "A" },
      { name: "Package B", caption: "B" },
    ],
  });

  assert.equal(selected, null);
  assert.equal(calls, 0);
});
