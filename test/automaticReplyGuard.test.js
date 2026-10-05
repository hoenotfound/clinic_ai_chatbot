const test = require("node:test");
const assert = require("node:assert/strict");

const contactsRepo = require("../src/db/contactsRepo");
const messagesRepo = require("../src/db/messagesRepo");
const { getAiOwnedContact } = require("../src/services/automaticReplyGuard");

test("automatic replies are blocked when the latest contact is in Staff mode", async (t) => {
  const originalGetContact = contactsRepo.getContactById;
  t.after(() => {
    contactsRepo.getContactById = originalGetContact;
  });

  contactsRepo.getContactById = async (id) => ({
    id,
    mode: "human",
    channel: "instagram",
  });

  const result = await getAiOwnedContact(
    { id: 42, mode: "ai", channel: "instagram" },
    { channel: "instagram", from: "igsid-42", reason: "voice-transcription fallback" }
  );

  assert.equal(result, null);
});

test("automatic replies continue when the latest contact remains AI-owned", async (t) => {
  const originalGetContact = contactsRepo.getContactById;
  t.after(() => {
    contactsRepo.getContactById = originalGetContact;
  });

  const latest = {
    id: 43,
    mode: "ai",
    channel: "facebook",
    channel_user_id: "psid-43",
  };
  contactsRepo.getContactById = async () => latest;

  const result = await getAiOwnedContact(
    { id: 43, mode: "ai", channel: "facebook" },
    { channel: "facebook", from: "psid-43", reason: "AI reply" }
  );

  assert.equal(result, latest);
});

test("Staff Assist blocks only the answered inbound turn while contact remains AI-owned", async (t) => {
  const originalGetContact = contactsRepo.getContactById;
  const originalHasStaffReplyAfter = messagesRepo.hasStaffReplyAfter;
  t.after(() => {
    contactsRepo.getContactById = originalGetContact;
    messagesRepo.hasStaffReplyAfter = originalHasStaffReplyAfter;
  });

  const latest = {
    id: 46,
    mode: "ai",
    channel: "whatsapp",
    whatsapp_number: "60129990000",
  };
  contactsRepo.getContactById = async () => latest;

  let checked = null;
  messagesRepo.hasStaffReplyAfter = async (contactId, inboundMessageId) => {
    checked = { contactId, inboundMessageId };
    return inboundMessageId === 501;
  };

  const answeredTurn = await getAiOwnedContact(
    latest,
    {
      channel: "whatsapp",
      from: "60129990000",
      reason: "AI provider send",
      inboundMessageId: 501,
    }
  );
  assert.equal(answeredTurn, null);
  assert.deepEqual(checked, { contactId: 46, inboundMessageId: 501 });

  const nextTurn = await getAiOwnedContact(
    latest,
    {
      channel: "whatsapp",
      from: "60129990000",
      reason: "AI provider send",
      inboundMessageId: 502,
    }
  );
  assert.equal(nextTurn, latest);
});

test("automatic reply ownership fails closed when the contact disappears", async (t) => {
  const originalGetContact = contactsRepo.getContactById;
  t.after(() => {
    contactsRepo.getContactById = originalGetContact;
  });

  contactsRepo.getContactById = async () => null;

  await assert.rejects(
    () => getAiOwnedContact({ id: 44 }, { reason: "processing-error fallback" }),
    /disappeared/
  );
});


test("global pause blocks automatic replies before ownership lookup", async (t) => {
  const originalGetContact = contactsRepo.getContactById;
  const originalFlag = process.env.AUTOMATED_REPLIES_ENABLED;
  let lookupCalled = false;

  t.after(() => {
    contactsRepo.getContactById = originalGetContact;
    if (originalFlag === undefined) delete process.env.AUTOMATED_REPLIES_ENABLED;
    else process.env.AUTOMATED_REPLIES_ENABLED = originalFlag;
  });

  process.env.AUTOMATED_REPLIES_ENABLED = "false";
  contactsRepo.getContactById = async () => {
    lookupCalled = true;
    return { id: 45, mode: "ai" };
  };

  const result = await getAiOwnedContact(
    { id: 45, mode: "ai", channel: "whatsapp" },
    { channel: "whatsapp", from: "60123456789", reason: "AI reply" }
  );

  assert.equal(result, null);
  assert.equal(lookupCalled, false);
});
