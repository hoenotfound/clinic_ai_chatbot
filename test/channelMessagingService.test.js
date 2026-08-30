const test = require("node:test");
const assert = require("node:assert/strict");

const whatsapp = require("../src/services/whatsappService");
const meta = require("../src/services/metaMessagingService");
const messaging = require("../src/services/channelMessagingService");

test("WhatsApp contacts keep using the existing WhatsApp send function", async (t) => {
  const originalWhatsappSend = whatsapp.sendMessage;
  const originalMetaSend = meta.sendText;
  t.after(() => {
    whatsapp.sendMessage = originalWhatsappSend;
    meta.sendText = originalMetaSend;
  });

  let whatsappCall = null;
  let metaCalls = 0;
  whatsapp.sendMessage = async (to, text) => {
    whatsappCall = { to, text };
    return { success: true, wamid: "wamid-1" };
  };
  meta.sendText = async () => {
    metaCalls += 1;
    return { success: true, wamid: null };
  };

  const result = await messaging.sendText(
    { channel: "whatsapp", whatsapp_number: "60123456789" },
    "Hello"
  );

  assert.deepEqual(whatsappCall, { to: "60123456789", text: "Hello" });
  assert.equal(metaCalls, 0);
  assert.equal(result.wamid, "wamid-1");
});

test("Facebook contacts never fall through to WhatsApp", async (t) => {
  const originalWhatsappSend = whatsapp.sendMessage;
  const originalMetaSend = meta.sendText;
  t.after(() => {
    whatsapp.sendMessage = originalWhatsappSend;
    meta.sendText = originalMetaSend;
  });

  let whatsappCalls = 0;
  let metaCall = null;
  whatsapp.sendMessage = async () => {
    whatsappCalls += 1;
    return { success: true, wamid: "wrong" };
  };
  meta.sendText = async (channel, to, text) => {
    metaCall = { channel, to, text };
    return { success: true, wamid: null, externalMessageId: "fb-1" };
  };

  await messaging.sendText(
    { channel: "facebook", channel_user_id: "psid-123", whatsapp_number: "facebook:psid-123" },
    "Hello FB"
  );

  assert.equal(whatsappCalls, 0);
  assert.deepEqual(metaCall, {
    channel: "facebook",
    to: "psid-123",
    text: "Hello FB",
  });
});
