"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

let label;
test("load Inbox-only sender label helper", async () => {
  ({ inboxSenderDisplayName: label } = await import("../portal-frontend/src/utils/inboxSenderDisplayName.js"));
  assert.equal(typeof label, "function");
});

test("Neutro primary displays DA regardless of stored or legacy name", async () => {
  const { inboxSenderDisplayName } = await import("../portal-frontend/src/utils/inboxSenderDisplayName.js");
  for (const current of ["Neutro Sense TCM", "Neutro Sense", ""]) {
    assert.equal(inboxSenderDisplayName({ channel: "whatsapp", whatsapp_sender_key: "neutro", whatsapp_sender_display_name: current }), "DA");
  }
});

test("secondary WhatsApp, other clients and other channels keep their original label", async () => {
  const { inboxSenderDisplayName } = await import("../portal-frontend/src/utils/inboxSenderDisplayName.js");
  assert.equal(inboxSenderDisplayName({ channel: "whatsapp", whatsapp_sender_key: "neutro_secondary", whatsapp_sender_display_name: "中医养生馆" }), "中医养生馆");
  assert.equal(inboxSenderDisplayName({ channel: "whatsapp", whatsapp_sender_key: "another_sender", whatsapp_sender_display_name: "Another Clinic" }), "Another Clinic");
  assert.equal(inboxSenderDisplayName({ channel: "facebook", whatsapp_sender_key: "neutro", whatsapp_sender_display_name: "Facebook" }), "Facebook");
  assert.equal(inboxSenderDisplayName({ channel: "whatsapp", whatsapp_sender_display_name: "" }), "");
});
