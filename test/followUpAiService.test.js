const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isSubstantiallySimilar,
  previousFollowUps,
  similarity,
  trimConversation,
} = require("../src/services/followUpAiService");

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
