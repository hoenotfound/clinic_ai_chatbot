"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { checkWhatsAppDispatchContact } = require("../src/services/whatsappSenderDispatchGuard");

const env = {
  WHATSAPP_MULTI_NUMBER_READ_ENABLED: "true",
  WHATSAPP_PHONE_NUMBER_ID: "1408739622311791",
  WHATSAPP_WABA_ID: "200000000000001",
  WHATSAPP_PRIMARY_SENDER_KEY: "neutro",
};
const contact = { id: 17, channel: "whatsapp", whatsapp_number: "60125550000" };
function database(row) {
  return { query: async () => ({ rows: row ? [row] : [] }) };
}
test("untagged Neutro legacy delivery is unchanged under staged reads", async () => {
  assert.equal(await checkWhatsAppDispatchContact(contact, {}, {
    env, database: database({
      whatsapp_sender_id: null, whatsapp_number: contact.whatsapp_number,
      sender_conversation_id: null,
    }),
  }), null);
});
test("persisted Neutro sender may send with verified phone and account", async () => {
  assert.equal(await checkWhatsAppDispatchContact(contact, {}, {
    env, database: database({
      whatsapp_sender_id: 1, whatsapp_number: contact.whatsapp_number,
      sender_conversation_id: 20, bound_sender_id: 1, customer_wa_id: contact.whatsapp_number, sender_key: "neutro",
      meta_phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID,
      meta_account_id: env.WHATSAPP_WABA_ID, sender_state: "active",
    }),
  }), null);
});
test("primary sender remains authorized when optional sender key is unset but DB identity is verified", async () => {
  const noKey = { ...env };
  delete noKey.WHATSAPP_PRIMARY_SENDER_KEY;
  assert.equal(await checkWhatsAppDispatchContact({
    ...contact, whatsapp_sender_key: "neutro",
    whatsapp_sender_phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID,
    whatsapp_sender_account_id: env.WHATSAPP_WABA_ID,
  }, {}, {
    env: noKey, database: database({
      whatsapp_sender_id: 1, whatsapp_number: contact.whatsapp_number,
      sender_conversation_id: 20, bound_sender_id: 1, customer_wa_id: contact.whatsapp_number, sender_key: "neutro",
      meta_phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID,
      meta_account_id: env.WHATSAPP_WABA_ID, sender_state: "active",
    }),
  }), null);
});
test("caller-supplied sender labels must agree with authoritative DB identity", async () => {
  const result = await checkWhatsAppDispatchContact({
    ...contact, whatsapp_sender_key: "ariel",
  }, {}, {
    env, database: database({
      whatsapp_sender_id: 1, whatsapp_number: contact.whatsapp_number,
      sender_conversation_id: 20, bound_sender_id: 1, customer_wa_id: contact.whatsapp_number, sender_key: "neutro",
      meta_phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID,
      meta_account_id: env.WHATSAPP_WABA_ID, sender_state: "active",
    }),
  });
  assert.equal(result.code, "whatsapp_sender_not_ready");
});
test("background retry missing sender fields still blocks Ariel by DB sender", async () => {
  const answer = await checkWhatsAppDispatchContact(contact, {}, {
    env, database: database({
      whatsapp_sender_id: 2, whatsapp_number: contact.whatsapp_number,
      sender_conversation_id: 21, bound_sender_id: 2, customer_wa_id: contact.whatsapp_number, sender_key: "ariel",
      meta_phone_number_id: "110552088553929",
      meta_account_id: "200000000000002", sender_state: "active",
    }),
  });
  assert.equal(answer.code, "whatsapp_sender_not_ready");
});
test("unknown, unbound, disabled or mismatched identities fail closed", async () => {
  for (const row of [
    null,
    { whatsapp_sender_id: 2, whatsapp_number: contact.whatsapp_number },
    { whatsapp_sender_id: 2, whatsapp_number: contact.whatsapp_number,
      sender_conversation_id: 21, bound_sender_id: 2, customer_wa_id: contact.whatsapp_number, sender_key: "neutro",
      meta_phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID,
      meta_account_id: env.WHATSAPP_WABA_ID, sender_state: "disabled" },
    { whatsapp_sender_id: null, whatsapp_number: contact.whatsapp_number,
      sender_conversation_id: 22 },
    { whatsapp_sender_id: null, whatsapp_number: "60122229999" },
    { whatsapp_sender_id: 2, whatsapp_number: contact.whatsapp_number,
      sender_conversation_id: 21, bound_sender_id: 1,
      customer_wa_id: contact.whatsapp_number, sender_key: "neutro",
      meta_phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID,
      meta_account_id: env.WHATSAPP_WABA_ID, sender_state: "active" },
  ]) {
    const answer = await checkWhatsAppDispatchContact(contact, {}, {
      env, database: database(row),
    });
    assert.equal(answer.code, "whatsapp_sender_not_ready");
  }
});
test("sender-aware database lookup failures cannot permit provider sending", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const answer = await checkWhatsAppDispatchContact(contact, {}, {
      env, database: { query: async () => { throw new Error("DB unavailable"); } },
    });
    assert.equal(answer.code, "whatsapp_sender_not_ready");
  } finally { console.error = original; }
});
test("unconfigured single-sender installations do not query sender tables", async () => {
  assert.equal(await checkWhatsAppDispatchContact(contact, {}, {
    env: { WHATSAPP_PHONE_NUMBER_ID: env.WHATSAPP_PHONE_NUMBER_ID },
    database: { query: async () => { throw new Error("must not query"); } },
  }), null);
});
