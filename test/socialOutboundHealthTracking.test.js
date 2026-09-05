const test = require("node:test");
const assert = require("node:assert/strict");

const channelMessaging = require("../src/services/channelMessagingService");
const metaMessaging = require("../src/services/metaMessagingService");
const metaAttachments = require("../src/services/metaAttachmentService");
const messagingPolicy = require("../src/services/whatsappPolicyService");
const runtimeHealthRepo = require("../src/db/messagingRuntimeHealthRepo");

test("accepted Messenger/Instagram sends record health without delaying the send result", async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPolicy = messagingPolicy.checkFreeformAllowed;
  const originalSendText = metaMessaging.sendText;
  const originalRecord = runtimeHealthRepo.recordOutboundAccepted;
  const recorded = [];

  process.env.DATABASE_URL = "postgresql://configured-for-production";
  messagingPolicy.checkFreeformAllowed = async () => ({ allowed: true });
  metaMessaging.sendText = async (channel) => ({
    success: true,
    wamid: null,
    externalMessageId: `${channel}-message-id`,
    error: null,
  });
  runtimeHealthRepo.recordOutboundAccepted = async (channel) => {
    recorded.push(channel);
    throw new Error("simulated telemetry failure");
  };

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const result = await channelMessaging.sendText(
      { channel: "instagram", channel_user_id: "recipient" },
      "hello"
    );
    assert.equal(result.success, true);
    assert.equal(result.externalMessageId, "instagram-message-id");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(recorded, ["instagram"]);
  } finally {
    console.error = originalConsoleError;
    messagingPolicy.checkFreeformAllowed = originalPolicy;
    metaMessaging.sendText = originalSendText;
    runtimeHealthRepo.recordOutboundAccepted = originalRecord;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

test("failed social sends do not create a successful outbound health signal", async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPolicy = messagingPolicy.checkFreeformAllowed;
  const originalSendText = metaMessaging.sendText;
  const originalRecord = runtimeHealthRepo.recordOutboundAccepted;
  let recorded = false;

  process.env.DATABASE_URL = "postgresql://configured-for-production";
  messagingPolicy.checkFreeformAllowed = async () => ({ allowed: true });
  metaMessaging.sendText = async () => ({
    success: false,
    wamid: null,
    externalMessageId: null,
    error: "rejected",
  });
  runtimeHealthRepo.recordOutboundAccepted = async () => {
    recorded = true;
  };

  try {
    const result = await channelMessaging.sendText(
      { channel: "facebook", channel_user_id: "recipient" },
      "hello"
    );
    assert.equal(result.success, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recorded, false);
  } finally {
    messagingPolicy.checkFreeformAllowed = originalPolicy;
    metaMessaging.sendText = originalSendText;
    runtimeHealthRepo.recordOutboundAccepted = originalRecord;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

test("a successful social caption does not mask a failed companion image", async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPolicy = messagingPolicy.checkFreeformAllowed;
  const originalSendText = metaMessaging.sendText;
  const originalSendBuffer = metaAttachments.sendBuffer;
  const originalRecord = runtimeHealthRepo.recordOutboundAccepted;
  let recorded = false;

  process.env.DATABASE_URL = "postgresql://configured-for-production";
  messagingPolicy.checkFreeformAllowed = async () => ({ allowed: true });
  metaMessaging.sendText = async () => ({
    success: true,
    wamid: null,
    externalMessageId: "caption-id",
    error: null,
  });
  metaAttachments.sendBuffer = async () => ({
    success: false,
    wamid: null,
    externalMessageId: null,
    error: "image rejected",
  });
  runtimeHealthRepo.recordOutboundAccepted = async () => {
    recorded = true;
  };

  try {
    const result = await channelMessaging.sendImageBuffer(
      { channel: "facebook", channel_user_id: "recipient" },
      Buffer.from("image"),
      "image/png",
      "caption",
      "image.png"
    );
    assert.equal(result.success, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recorded, false);
  } finally {
    messagingPolicy.checkFreeformAllowed = originalPolicy;
    metaMessaging.sendText = originalSendText;
    metaAttachments.sendBuffer = originalSendBuffer;
    runtimeHealthRepo.recordOutboundAccepted = originalRecord;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});