const test = require("node:test");
const assert = require("node:assert/strict");

const whatsapp = require("../src/services/whatsappService");
const contactsRepo = require("../src/db/contactsRepo");
const inboundProcessingRepo = require("../src/db/inboundProcessingRepo");
const senderConversations = require("../src/db/whatsappSenderConversationRepo");
const echoMutations = require("../src/services/whatsappCoexistenceMutationService");
const aiReplyCancellation = require("../src/services/aiReplyCancellationService");
const coexistence = require("../src/services/whatsappCoexistenceService");

function echoPayload(message) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-1",
      changes: [{
        field: "smb_message_echoes",
        value: {
          metadata: {
            display_phone_number: "60122972817",
            phone_number_id: "110552088553929",
          },
          message_echoes: [message],
        },
      }],
    }],
  };
}

test("Business App text echo is parsed as outbound staff work, not customer inbound", () => {
  const body = echoPayload({
    from: "60122972817",
    to: "60135550000",
    id: "wamid.echo-1",
    timestamp: "1790320000",
    type: "text",
    text: { body: "I will help you from here." },
  });

  assert.deepEqual(whatsapp.parseIncomingMessages(body), []);
  assert.deepEqual(whatsapp.parseBusinessAppEchoes(body), [{
    id: "wamid.echo-1",
    from: "60122972817",
    to: "60135550000",
    businessPhoneNumberId: "110552088553929",
    businessAccountId: "waba-1",
    timestamp: "1790320000",
    type: "text",
    mediaId: null,
    text: "I will help you from here.",
  }]);
});

test("Business App edited text uses the nested Meta message shape, never inbound AI", () => {
  const body = echoPayload({
    from: "60122972817", to: "60135550000",
    id: "wamid.HBgLZWRpdC1ldmVudAA=",
    type: "edit",
    edit: {
      original_message_id: "wamid.HBgLb3JpZ2luYWw=",
      message: { type: "text", text: { body: "Corrected staff reply" } },
    },
  });
  assert.deepEqual(whatsapp.parseIncomingMessages(body), []);
  const [event] = whatsapp.parseBusinessAppEchoes(body);
  assert.equal(event.type, "edit");
  assert.equal(event.originalMessageId, "wamid.HBgLb3JpZ2luYWw=");
  assert.equal(event.text, "Corrected staff reply");
  assert.equal(event.businessPhoneNumberId, "110552088553929");
  assert.equal(event.businessAccountId, "waba-1");
});

test("Business App edits support caption updates and preserve legacy text", () => {
  const media = echoPayload({
    id: "wamid.caption=", to: "60135550000", type: "edit",
    edit: {
      original_message_id: "wamid.old+media/=",
      message: { type: "image", image: { caption: "Updated caption" } },
    },
  });
  assert.equal(whatsapp.parseBusinessAppEchoes(media)[0].text, "Updated caption");

  const legacy = echoPayload({
    id: "wamid.legacy=", to: "60135550000", type: "edit",
    edit: { original_message_id: "wamid.old=", text: { body: "Legacy edit" } },
  });
  assert.equal(whatsapp.parseBusinessAppEchoes(legacy)[0].text, "Legacy edit");

  const unsupported = echoPayload({
    id: "wamid.unsupported=", to: "60135550000", type: "edit",
    edit: { original_message_id: "wamid.old=", message: { type: "audio" } },
  });
  assert.equal(whatsapp.parseBusinessAppEchoes(unsupported)[0].text, null);
});

test("Business App revocations retain padded provider IDs without creating an inbound turn", () => {
  const body = echoPayload({
    id: "wamid.revoke=", to: "60135550000", type: "revoke",
    revoke: { original_message_id: "wamid.original/+=" },
  });
  assert.deepEqual(whatsapp.parseIncomingMessages(body), []);
  const [event] = whatsapp.parseBusinessAppEchoes(body);
  assert.equal(event.originalMessageId, "wamid.original/+=");
  assert.equal(event.text, null);
});

test("Business App echo cancellation invalidates an in-flight AI token", () => {
  const key = aiReplyCancellation.keyForWhatsAppNumber("60135550000");
  const token = aiReplyCancellation.snapshot(key);
  coexistence.cancelPendingAiForEcho({ to: "60135550000" });
  assert.equal(aiReplyCancellation.cancelledSince(key, token), true);
});

test("deleted Business App echo retry is ignored before recreating the contact", async (t) => {
  const originalDeletedCheck = inboundProcessingRepo.isDeletedProviderMessageId;
  const originalGetOrCreate = contactsRepo.getOrCreateContact;
  t.after(() => {
    inboundProcessingRepo.isDeletedProviderMessageId = originalDeletedCheck;
    contactsRepo.getOrCreateContact = originalGetOrCreate;
  });

  const echo = {
    id: "wamid.deleted-staff-echo",
    to: "60135550000",
    type: "text",
    text: "Old staff retry",
  };
  const key = aiReplyCancellation.keyForWhatsAppNumber(echo.to);
  coexistence.beginPendingAiForEcho(echo);

  inboundProcessingRepo.isDeletedProviderMessageId = async (providerMessageId) => {
    assert.equal(providerMessageId, echo.id);
    return true;
  };
  contactsRepo.getOrCreateContact = async () => {
    assert.fail("deleted Business App echo retry must not recreate a contact");
  };

  const result = await coexistence.persistBusinessAppEcho(echo, {
    pendingStarted: true,
  });

  assert.equal(result, null);
  assert.equal(aiReplyCancellation.hasPendingEcho(key), false);
});

// No real customer records, Meta callbacks or sends are involved. The
// secondary sender is synthetic and every database entrypoint is stubbed.
function mockSecondaryMutation(t) {
  const keys = [
    "WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED",
    "WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED",
    "WHATSAPP_SECONDARY_PHONE_NUMBER_ID",
    "WHATSAPP_SECONDARY_WABA_ID",
    "WHATSAPP_SECONDARY_SENDER_KEY",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_WABA_ID",
    "WHATSAPP_PRIMARY_SENDER_KEY",
  ];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED: "true",
    WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED: "true",
    WHATSAPP_SECONDARY_PHONE_NUMBER_ID: "110552088553929",
    WHATSAPP_SECONDARY_WABA_ID: "200000000000002",
    WHATSAPP_SECONDARY_SENDER_KEY: "ariel",
    WHATSAPP_PHONE_NUMBER_ID: "100000000000001",
    WHATSAPP_WABA_ID: "200000000000001",
    WHATSAPP_PRIMARY_SENDER_KEY: "neutro",
  });
  const originals = {
    deleted: inboundProcessingRepo.isDeletedProviderMessageId,
    find: senderConversations.findBoundContactForSender,
    claim: senderConversations.claimSenderContact,
    create: contactsRepo.getOrCreateContact,
    record: echoMutations.record,
  };
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    inboundProcessingRepo.isDeletedProviderMessageId = originals.deleted;
    senderConversations.findBoundContactForSender = originals.find;
    senderConversations.claimSenderContact = originals.claim;
    contactsRepo.getOrCreateContact = originals.create;
    echoMutations.record = originals.record;
  });
  const calls = [];
  inboundProcessingRepo.isDeletedProviderMessageId = async () => false;
  senderConversations.claimSenderContact = async () => {
    assert.fail("mutation must not claim or create a sender contact");
  };
  contactsRepo.getOrCreateContact = async () => {
    assert.fail("mutation must not create a legacy contact");
  };
  senderConversations.findBoundContactForSender = async (identity) => {
    calls.push(identity);
    return null;
  };
  echoMutations.record = async () => {
    assert.fail("missing-contact mutation must not be recorded");
  };
  const echo = {
    id: "wamid.edit-1", originalMessageId: "wamid.old-1",
    type: "edit", text: "Corrected previous staff message",
    to: "60135550000", businessPhoneNumberId: "110552088553929",
    businessAccountId: "200000000000002",
  };
  return {echo,calls};
}

test("old Business App mutations do not create a contact or interrupt secondary AI", async (t) => {
  const {echo,calls} = mockSecondaryMutation(t);
  const key = aiReplyCancellation.keyForWhatsAppNumber(echo.to, "ariel");
  const snapshot = aiReplyCancellation.snapshot(key);
  assert.equal(coexistence.beginPendingAiForEcho(echo), false);
  assert.equal(aiReplyCancellation.hasPendingEcho(key), false);
  assert.equal(await coexistence.persistBusinessAppEcho(echo, {pendingStarted:true}), null);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    accountId: echo.businessAccountId,
    phoneNumberId: echo.businessPhoneNumberId,
    customerPhone: echo.to,
    senderKey: "ariel",
  });
  assert.equal(aiReplyCancellation.safeToSend(key, snapshot), true);
  assert.equal(aiReplyCancellation.cancelledSince(key, snapshot), false);
});

test("existing-contact edit/revoke applies or stays pending without cancelling AI", async (t) => {
  const {echo,calls} = mockSecondaryMutation(t);
  const contact = {
    id: 14, whatsapp_sender_id: 5,
    whatsapp_sender_conversation_id: 17, whatsapp_number: echo.to,
  };
  senderConversations.findBoundContactForSender = async identity => {
    calls.push(identity);
    return contact;
  };
  const outcomes = [
    {isNew:true,messageId:55},
    {isNew:true,pending:true},
    {isNew:false,alreadySeen:true},
  ];
  let records=0;
  echoMutations.record = async (event,owner) => {
    assert.equal(owner,contact);
    assert.equal(event.businessPhoneNumberId,echo.businessPhoneNumberId);
    return outcomes[records++];
  };
  const key = aiReplyCancellation.keyForWhatsAppNumber(echo.to, "ariel");
  const token = aiReplyCancellation.snapshot(key);
  for (const [index,outcome] of outcomes.entries()) {
    const event={...echo,id:"wamid.mutation-"+index,type:index===2?"revoke":"edit"};
    assert.equal(coexistence.beginPendingAiForEcho(event),false);
    const result=await coexistence.persistBusinessAppEcho(event,{pendingStarted:true});
    if (outcome.messageId) {
      assert.equal(result.isMutation,true);
      assert.equal(result.message.id,55);
    } else {
      assert.equal(result,null);
    }
    assert.equal(aiReplyCancellation.safeToSend(key,token),true);
    assert.equal(aiReplyCancellation.cancelledSince(key,token),false);
  }
  assert.equal(records,3);
  assert.equal(calls.length,3);
});

test("foreign-sender edit is rejected without claiming contacts or cancelling primary AI", async(t) => {
  const {echo,calls}=mockSecondaryMutation(t);
  const primaryKey=aiReplyCancellation.keyForWhatsAppNumber(echo.to,"neutro");
  const token=aiReplyCancellation.snapshot(primaryKey);
  await assert.rejects(
    coexistence.persistBusinessAppEcho({...echo,businessAccountId:"999000000000001"}),
    /does not identify the verified primary sender/
  );
  assert.equal(calls.length,0);
  assert.equal(aiReplyCancellation.safeToSend(primaryKey,token),true);
});

test("genuine new Business App staff replies still block AI while awaiting persistence", (t) => {
  const {echo}=mockSecondaryMutation(t);
  const fresh={...echo,id:"wamid.new-staff",type:"text",text:"Staff replied"};
  const key=aiReplyCancellation.keyForWhatsAppNumber(echo.to,"ariel");
  const token=aiReplyCancellation.snapshot(key);
  assert.equal(coexistence.beginPendingAiForEcho(fresh),true);
  assert.equal(aiReplyCancellation.safeToSend(key,token),false);
  coexistence.releasePendingAiForEcho(fresh);
  assert.equal(aiReplyCancellation.safeToSend(key,token),true);
});

test("Cloud API message_echoes do not enter the Business App coexistence path", () => {
  const body = {
    entry: [{
      changes: [{
        field: "message_echoes",
        value: {
          message_echoes: [{
            from: "60122972817",
            to: "60135550000",
            id: "wamid.cloud-api-1",
            type: "text",
            text: { body: "API outbound" },
          }],
        },
      }],
    }],
  };
  assert.deepEqual(whatsapp.parseBusinessAppEchoes(body), []);
  assert.deepEqual(whatsapp.parseIncomingMessages(body), []);
});

test("history and app-state sync are recognized without becoming AI inbound messages", () => {
  const body = {
    entry: [{
      changes: [
        {
          field: "history",
          value: {
            history: [{
              metadata: { phase: 0, chunk_order: 1, progress: 100 },
              threads: [{
                id: "60135550000",
                messages: [{
                  id: "wamid.old",
                  from: "60135550000",
                  to: "60122972817",
                  type: "text",
                  text: { body: "old customer message" },
                }],
              }],
            }],
          },
        },
        {
          field: "smb_app_state_sync",
          value: {
            state_sync: [{
              type: "contact",
              action: "add",
              contact: { full_name: "Customer", phone_number: "60135550000" },
            }],
          },
        },
      ],
    }],
  };

  assert.deepEqual(whatsapp.parseIncomingMessages(body), []);
  assert.deepEqual(whatsapp.parseBusinessAppEchoes(body), []);
  assert.deepEqual(coexistence.summarizePassiveSync(body), {
    historyChunks: 1,
    appStateItems: 1,
  });
});


test("in-flight AI settle guard suppresses send when a Business App echo arrives", async () => {
  const previous = process.env.WHATSAPP_COEXISTENCE_ENABLED;
  process.env.WHATSAPP_COEXISTENCE_ENABLED = "true";
  try {
    const key = aiReplyCancellation.keyForWhatsAppNumber("60137770000");
    const token = aiReplyCancellation.snapshot(key);
    const guarded = aiReplyCancellation.settleBeforeSend(key, token, {
      delayMs: 25,
      pendingWaitMs: 100,
      pollMs: 5,
    });
    setTimeout(() => aiReplyCancellation.cancel(key), 5);
    assert.equal(await guarded, false);
  } finally {
    if (previous == null) delete process.env.WHATSAPP_COEXISTENCE_ENABLED;
    else process.env.WHATSAPP_COEXISTENCE_ENABLED = previous;
  }
});

test("non-coexistence Inbox Staff Assist still cancels an in-flight WhatsApp reply", async () => {
  const previous = process.env.WHATSAPP_COEXISTENCE_ENABLED;
  delete process.env.WHATSAPP_COEXISTENCE_ENABLED;
  try {
    const key = aiReplyCancellation.keyForWhatsAppNumber("60138880000");
    const token = aiReplyCancellation.snapshot(key);
    aiReplyCancellation.cancel(key);
    assert.equal(
      await aiReplyCancellation.settleBeforeSend(key, token, {
        delayMs: 1000,
        pendingWaitMs: 1000,
      }),
      false
    );
  } finally {
    if (previous == null) delete process.env.WHATSAPP_COEXISTENCE_ENABLED;
    else process.env.WHATSAPP_COEXISTENCE_ENABLED = previous;
  }
});


test("pending Business App echo blocks AI before durable persistence finishes", async () => {
  const previous = process.env.WHATSAPP_COEXISTENCE_ENABLED;
  process.env.WHATSAPP_COEXISTENCE_ENABLED = "true";
  try {
    const echo = { id: "wamid.pending-1", to: "60139990000" };
    const key = aiReplyCancellation.keyForWhatsAppNumber(echo.to);
    const token = aiReplyCancellation.snapshot(key);

    coexistence.beginPendingAiForEcho(echo);
    assert.equal(aiReplyCancellation.safeToSend(key, token), false);

    const guarded = aiReplyCancellation.settleBeforeSend(key, token, {
      delayMs: 1,
      pendingWaitMs: 20,
      pollMs: 2,
    });
    assert.equal(await guarded, false);

    coexistence.releasePendingAiForEcho(echo);
    assert.equal(aiReplyCancellation.safeToSend(key, token), true);
  } finally {
    if (previous == null) delete process.env.WHATSAPP_COEXISTENCE_ENABLED;
    else process.env.WHATSAPP_COEXISTENCE_ENABLED = previous;
  }
});

test("duplicate echo can be released without permanently cancelling a later AI turn", () => {
  const echo = { id: "wamid.duplicate-1", to: "60131112222" };
  const key = aiReplyCancellation.keyForWhatsAppNumber(echo.to);
  const token = aiReplyCancellation.snapshot(key);

  coexistence.beginPendingAiForEcho(echo);
  assert.equal(aiReplyCancellation.safeToSend(key, token), false);
  coexistence.releasePendingAiForEcho(echo);

  assert.equal(aiReplyCancellation.safeToSend(key, token), true);
});
