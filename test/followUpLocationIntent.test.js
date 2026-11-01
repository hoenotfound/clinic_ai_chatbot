"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { customerRequestsNearbyAlternative } = require("../src/utils/followUpLocationIntent");

test("stops follow-up when customer clearly wants a local provider outside PJ", () => {
  assert.equal(customerRequestsNearbyAlternative({
    recent_inbound_messages: ["我住在johor, 我想找靠近这里的地方。", "你们的地点在那里呢？"],
  }), true);
  assert.equal(customerRequestsNearbyAlternative({
    recent_inbound_messages: ["I live in Sarawak and prefer somewhere nearer to me."],
  }), true);
});

test("does not suppress a remote customer simply for mentioning where they live", () => {
  for (const messages of [
    ["Sarawak"],
    ["Johor", "想了解你们的骨盆疗程"],
    ["I live in Johor but I will come to PJ next Tuesday"],
    ["我住Johor，但会来KL做体验"],
    ["我想找靠近这里的地方"],
    ["我住在 PJ，我想找附近的调理"],
    [],
  ]) assert.equal(customerRequestsNearbyAlternative({
    recent_inbound_messages: messages,
  }), false, messages.join(" | "));
});

test("a fresh intention to visit PJ overrides an older out-of-area alternative", () => {
  assert.equal(customerRequestsNearbyAlternative({
    recent_inbound_messages: ["我可以来PJ做护理", "我住在johor, 我想找靠近这里的地方。"],
  }), false);
});
