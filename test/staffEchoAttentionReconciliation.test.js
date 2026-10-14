"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const contacts = require("../src/db/contactsRepo");
const pipeline = require("../src/db/pipelineRepo");
const realtime = require("../src/utils/realtimeEvents");
const whatsapp = require("../src/services/whatsappCoexistenceService");
const social = require("../src/services/metaStaffEchoService");

test("confirmed WhatsApp Business App and Meta echoes reconcile delivery attention on replay without double sending", async (t) => {
  const originals = {
    clear: contacts.clearDeliveryAttentionIfNoFailedMessages,
    ensure: pipeline.ensureLeadForContact,
    contacted: pipeline.markContactedForContact,
    publish: realtime.publish,
  };
  t.after(() => {
    contacts.clearDeliveryAttentionIfNoFailedMessages = originals.clear;
    pipeline.ensureLeadForContact = originals.ensure;
    pipeline.markContactedForContact = originals.contacted;
    realtime.publish = originals.publish;
  });
  const calls = [];
  contacts.clearDeliveryAttentionIfNoFailedMessages = async (id) => {
    calls.push(["clear", id]);
    return null;
  };
  pipeline.ensureLeadForContact = async () => {};
  pipeline.markContactedForContact = async () => {};
  realtime.publish = () => {};

  // A recovered duplicate echo still has provider-accepted evidence. Its
  // post-commit side effects must be safe to replay after a prior crash.
  await whatsapp.finalizeBusinessAppEcho({
    contact: { id: 81 },
    message: { id: 91, whatsapp_message_id: "wamid.biz91" },
    isNew: false,
  });
  await social.finalizeStaffEcho({
    contact: { id: 82 },
    message: { id: 92, whatsapp_message_id: "facebook:mid92" },
    isNew: false,
  });
  assert.deepEqual(calls, [["clear", 81], ["clear", 82]]);

  // A transient attention-reconciliation error does not make Meta resend a
  // message that was durably persisted and already accepted.
  contacts.clearDeliveryAttentionIfNoFailedMessages = async () => {
    throw new Error("temporary database attention error");
  };
  await whatsapp.finalizeBusinessAppEcho({
    contact: { id: 81 },
    message: { id: 91 },
    isNew: false,
  });
});
