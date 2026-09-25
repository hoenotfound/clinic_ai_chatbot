const test = require("node:test");
const assert = require("node:assert/strict");

const contactsRepo = require("../src/db/contactsRepo");
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
