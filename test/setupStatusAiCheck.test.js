const test = require("node:test");
const assert = require("node:assert/strict");

const aiService = require("../src/services/aiService");
const { setupStatusAi } = require("../src/routes/setupStatus");

test("setup-status AI checks explicitly enable the lightweight private request path", async () => {
  const originalGetReply = aiService.getReply;
  let received = null;
  aiService.getReply = async (messages, options) => {
    received = { messages, options };
    return JSON.stringify({
      reply: "OK",
      outcome: "normal",
      treatment: null,
      branch: null,
      appointmentPreference: null,
    });
  };

  try {
    await setupStatusAi.getReply(
      [{ role: "user", content: "Private setup check: reply briefly." }],
      { channel: "whatsapp", isFirstMessage: false }
    );
    assert.equal(received.options.privateSetupCheck, true);
    assert.equal(received.options.channel, "whatsapp");
    assert.equal(received.options.isFirstMessage, false);
  } finally {
    aiService.getReply = originalGetReply;
  }
});
