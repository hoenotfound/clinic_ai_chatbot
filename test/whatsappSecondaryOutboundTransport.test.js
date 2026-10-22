"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createVerifiedSecondaryOutboundTransport } =
  require("../src/services/whatsappSenderOutboundTransport");
const { blockUnverifiedOutgoingSender } =
  require("../src/services/whatsappSenderOutgoingGuard");

const env = {
  WHATSAPP_PHONE_NUMBER_ID: "100100100",
  WHATSAPP_WABA_ID: "200200200",
  WHATSAPP_TOKEN: "primary-secret",
  WHATSAPP_PRIMARY_SENDER_KEY: "neutro",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID: "300300300",
  WHATSAPP_SECONDARY_WABA_ID: "400400400",
  WHATSAPP_SECONDARY_SENDER_KEY: "ariel",
  WHATSAPP_SECONDARY_TOKEN: "secondary-secret",
  WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED: "true",
  WHATSAPP_MULTI_NUMBER_READ_ENABLED: "true",
  WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED: "true",
  WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED: "true",
};
const contact = { id: 52, channel: "whatsapp", whatsapp_number: "60125550000" };
function boundRow() {
  return {
    whatsapp_number: contact.whatsapp_number,
    whatsapp_sender_id: "2",
    bound_sender_id: "2",
    customer_wa_id: contact.whatsapp_number,
    binding_state: "bound",
    sender_key: "ariel",
    meta_phone_number_id: env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
    meta_account_id: env.WHATSAPP_SECONDARY_WABA_ID,
    sender_state: "active",
  };
}
function database(rows = [boundRow()]) {
  return { query: async (_sql, args) => {
    assert.deepEqual(args, [contact.id]);
    return { rows };
  } };
}
function mockedFetch(calls, response = () => ({ messages: [{ id: "wamid.test" }] })) {
  return async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, text: async () => JSON.stringify(response()) };
  };
}
async function transport(calls, overrides = {}) {
  return createVerifiedSecondaryOutboundTransport(contact, {
    env, database: database(), fetchImpl: mockedFetch(calls), ...overrides,
  });
}
async function denied(promise) {
  await assert.rejects(promise, error => error?.code === "whatsapp_sender_not_ready");
}

test("secondary transport is inert unless deliberately staged with all four gates", async () => {
  for (const key of [
    "WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED",
    "WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED",
    "WHATSAPP_MULTI_NUMBER_READ_ENABLED",
    "WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED",
  ]) {
    await denied(createVerifiedSecondaryOutboundTransport(contact, {
      database: database(),
      env: { ...env, [key]: "false" },
    }));
  }
  await denied(createVerifiedSecondaryOutboundTransport(contact, {
    database: database(), env: { ...env, WHATSAPP_SECONDARY_TOKEN: "" },
  }));
});

test("sender identity comes from bound DB row, not caller labels or customer number", async () => {
  for (const row of [
    null,
    { ...boundRow(), sender_state: "disabled" },
    { ...boundRow(), binding_state: "pending" },
    { ...boundRow(), sender_key: "neutro" },
    { ...boundRow(), meta_phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID },
    { ...boundRow(), meta_account_id: env.WHATSAPP_WABA_ID },
    { ...boundRow(), whatsapp_sender_id: "1" },
    { ...boundRow(), customer_wa_id: "60129999999" },
    { ...boundRow(), whatsapp_number: "60129999999" },
  ]) {
    await denied(createVerifiedSecondaryOutboundTransport(contact, {
      env, database: database(row ? [row] : []),
    }));
  }
  await denied(createVerifiedSecondaryOutboundTransport(
    { ...contact, whatsapp_sender_key: "neutro" },
    { env, database: database() }
  ));
  await denied(createVerifiedSecondaryOutboundTransport(
    { ...contact, whatsapp_sender_phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID },
    { env, database: database() }
  ));
  await denied(createVerifiedSecondaryOutboundTransport(contact, {
    env, database: { query: async () => { throw new Error("connection failed"); } },
  }));
});

test("never resolve Ariel using Neutro primary phone/account credentials", async () => {
  for (const badEnv of [
    { ...env, WHATSAPP_SECONDARY_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID },
    { ...env, WHATSAPP_SECONDARY_TOKEN: "" },
  ]) {
    await denied(createVerifiedSecondaryOutboundTransport(contact, {
      env: badEnv, database: database(),
    }));
  }
  const calls = [];
  const client = await transport(calls);
  assert.equal(client.senderKey, "ariel");
  assert.equal(client.token, undefined);
  const result = await client.sendText("Hello from Ariel");
  assert.equal(result.success, true);
  assert.equal(result.wamid, "wamid.test");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://graph.facebook.com/v26.0/300300300/messages");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secondary-secret");
  assert.equal(calls[0].options.body.includes("primary-secret"), false);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    messaging_product: "whatsapp", to: contact.whatsapp_number,
    type: "text", text: { body: "Hello from Ariel" },
  });
  // The existing low-level Neutro API remains blocked for this contact.
  assert.equal(blockUnverifiedOutgoingSender({
    ...contact, whatsapp_sender_key: "ariel",
    whatsapp_sender_phone_number_id: env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
  }, {}, env).code, "whatsapp_sender_not_ready");
});

test("image, buttons, audio voice, video, documents and templates keep Ariel credentials", async () => {
  const calls = [];
  const client = await transport(calls);
  await client.sendInteractiveButtons("Choose", [
    { id: "yes", title: "Yes" }, { id: "no", title: "No" },
  ]);
  await client.sendImageByUrl("https://cdn.example.com/pic.jpg", "Caption");
  await client.sendMediaById("audio", "audio-id", { voice: true });
  await client.sendMediaById("video", "video-id", { caption: "Video" });
  await client.sendMediaById("document", "document-id", { filename: "record.pdf" });
  await client.sendMediaById("sticker", "sticker-id");
  await client.sendTemplatePayload("appointment_reminder", "en_US", []);
  assert.equal(calls.length, 7);
  for (const call of calls) {
    assert.equal(call.url, "https://graph.facebook.com/v26.0/300300300/messages");
    assert.equal(call.options.headers.Authorization, "Bearer secondary-secret");
    assert.equal(JSON.parse(call.options.body).to, contact.whatsapp_number);
  }
  assert.deepEqual(JSON.parse(calls[2].options.body).audio, { id: "audio-id", voice: true });
  assert.equal(JSON.parse(calls[6].options.body).template.name, "appointment_reminder");
});

test("media is uploaded to the same Ariel phone with no primary-token fallback", async () => {
  const calls = [];
  const client = await transport(calls, {
    fetchImpl: mockedFetch(calls, () => ({ id: "ariel-media-id" })),
  });
  const result = await client.uploadMedia(Buffer.from("some-bytes"), "image/png", "image.png");
  assert.deepEqual(result, { success: true, mediaId: "ariel-media-id" });
  assert.equal(calls[0].url, "https://graph.facebook.com/v26.0/300300300/media");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secondary-secret");
  assert.equal(calls[0].options.body.get("messaging_product"), "whatsapp");
  assert.equal((await calls[0].options.body.get("file").text()), "some-bytes");
});

test("transport returns unknown outcome on interrupted send and never auto-retries", async () => {
  let count = 0;
  const client = await createVerifiedSecondaryOutboundTransport(contact, {
    env, database: database(), fetchImpl: async () => {
      count += 1;
      throw new Error("Network timeout");
    },
  });
  const result = await client.sendText("Do not repeat without reconciliation");
  assert.equal(result.success, false);
  assert.equal(result.ambiguous, true);
  assert.equal(result.retryable, false);
  assert.equal(count, 1);
});

test("revoked or reassigned sender is blocked again before any Meta request", async () => {
  let state = "active";
  const calls = [];
  const client = await createVerifiedSecondaryOutboundTransport(contact, {
    env, fetchImpl: mockedFetch(calls),
    database: {
      query: async () => ({ rows: [{ ...boundRow(), sender_state: state }] }),
    },
  });
  state = "disabled";
  await denied(client.sendText("This must not send"));
  await denied(client.uploadMedia(Buffer.from("bytes"), "image/png", "test.png"));
  assert.equal(calls.length, 0);
});

test("invalid payloads do not reach Graph API", async () => {
  const calls = [];
  const client = await transport(calls);
  assert.equal((await client.sendText(" ")).success, false);
  assert.equal((await client.sendMediaById("audio", "", { voice: true })).success, false);
  assert.equal((await client.sendMediaById("video", "id", { voice: true })).success, false);
  assert.equal((await client.sendTemplatePayload("Bad Name", "en_US", [])).success, false);
  assert.equal((await client.uploadMedia(Buffer.alloc(0), "image/png", "x")).success, false);
  assert.equal(calls.length, 0);
});
