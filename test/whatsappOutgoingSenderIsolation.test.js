"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { blockUnverifiedOutgoingSender } = require("../src/services/whatsappSenderOutgoingGuard");
const channel = require("../src/services/channelMessagingService");
const wa = require("../src/services/whatsappService");
const templates = require("../src/services/whatsappTemplateService");

const env = {
  WHATSAPP_PHONE_NUMBER_ID: "1408739622311791",
  WHATSAPP_WABA_ID: "200000000000001",
  WHATSAPP_PRIMARY_SENDER_KEY: "neutro",
};

test("legacy sending context is preserved unchanged", () => {
  assert.equal(blockUnverifiedOutgoingSender({ channel: "whatsapp" }, {}, env), null);
  assert.equal(blockUnverifiedOutgoingSender({
    channel: "whatsapp",
    whatsapp_sender_key: "neutro",
    whatsapp_sender_phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID,
  }, {}, env), null);
});

test("foreign phone, sender key and account mismatch are blocked", () => {
  for (const contact of [
    { channel: "whatsapp", whatsapp_sender_phone_number_id: "110552088553929" },
    { channel: "whatsapp", whatsapp_sender_key: "ariel",
      whatsapp_sender_phone_number_id: "110552088553929" },
    { channel: "whatsapp", whatsapp_sender_key: "ariel",
      whatsapp_sender_phone_number_id: "1408739622311791" },
    { channel: "whatsapp", businessAccountId: "200000000000002",
      businessPhoneNumberId: "1408739622311791" },
    { channel: "whatsapp", whatsapp_sender_key: "neutro" },
  ]) {
    const blocked = blockUnverifiedOutgoingSender(contact, {}, env);
    assert.equal(blocked.policyBlocked, true);
    assert.equal(blocked.retryable, false);
  }
});

test("foreign sender blocks staff and AI text before policy queries or network use", async () => {
  const result = await channel.sendText({
    channel: "whatsapp",
    whatsapp_number: "60125550000",
    whatsapp_sender_phone_number_id: "110552088553929",
  }, "test");
  assert.equal(result.code, "whatsapp_sender_not_ready");
});

test("every low-level WhatsApp sender refuses explicitly foreign business ID", async () => {
  const options = { businessPhoneNumberId: "110552088553929" };
  const jobs = [
    wa.sendMessage("60125550000", "hi", options),
    wa.sendInteractiveButtons("60125550000", "hi", [], options),
    wa.sendImage("60125550000", "https://example.com/x.png", "", options),
    wa.sendImageById("60125550000", "media", "", options),
    wa.sendVideoById("60125550000", "media", "", options),
    wa.sendDocumentById("60125550000", "media", "file.pdf", "", options),
    wa.sendStickerById("60125550000", "media", options),
    wa.sendVoiceById("60125550000", "media", options),
  ];
  for (const result of await Promise.all(jobs)) {
    assert.equal(result.code, "whatsapp_sender_not_ready");
  }
  assert.equal(await wa.uploadMedia(Buffer.from("123"), "image/png", "x.png", options), null);
});

test("templates refuse foreign sender before billing or provider lookup", async () => {
  const result = await templates.sendApprovedTemplate({
    whatsapp_number: "60125550000",
    channel: "whatsapp",
    whatsapp_sender_phone_number_id: "110552088553929",
  }, { templateName: "hello" });
  assert.equal(result.code, "whatsapp_sender_not_ready");
});
