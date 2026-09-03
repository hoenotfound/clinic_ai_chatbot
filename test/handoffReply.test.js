const test = require("node:test");
const assert = require("node:assert/strict");

const {
  fallbackHandoffReply,
  isUrgentSafetyMessage,
} = require("../src/utils/handoffReply");

test("urgent breathing/pain symptoms get immediate-care guidance in English", () => {
  const reply = fallbackHandoffReply("I'm having trouble breathing and it's getting worse");
  assert.equal(isUrgentSafetyMessage("I'm having trouble breathing"), true);
  assert.match(reply, /urgent medical attention/i);
  assert.match(reply, /emergency medical care immediately/i);
});

test("urgent symptoms get immediate-care guidance in Bahasa Malaysia and Chinese", () => {
  const ms = fallbackHandoffReply("saya susah bernafas dan makin sakit");
  const zh = fallbackHandoffReply("我呼吸困难而且越来越严重");
  assert.match(ms, /rawatan kecemasan segera/i);
  assert.match(zh, /紧急医疗帮助/u);
});

test("ordinary treatment pain questions still use the normal handoff path when one is requested", () => {
  assert.equal(isUrgentSafetyMessage("HIFU sakit tak?"), false);
  assert.equal(isUrgentSafetyMessage("HIFU会很痛吗？"), false);
  const reply = fallbackHandoffReply("HIFU会很痛吗？");
  assert.doesNotMatch(reply, /紧急医疗帮助/u);
});