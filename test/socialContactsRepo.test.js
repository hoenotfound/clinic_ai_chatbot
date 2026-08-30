const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const contactsRepo = require("../src/db/contactsRepo");

test("creates a Facebook contact with a separate channel recipient id", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /INSERT INTO contacts/);
    assert.match(sql, /channel_user_id/);
    assert.match(sql, /ON CONFLICT \(whatsapp_number\) DO UPDATE/);
    assert.deepEqual(params, [
      "facebook:psid-123",
      "facebook",
      "psid-123",
      null,
      null,
    ]);
    return {
      rows: [
        {
          id: 91,
          whatsapp_number: "facebook:psid-123",
          channel: "facebook",
          channel_user_id: "psid-123",
        },
      ],
    };
  };

  const contact = await contactsRepo.getOrCreateChannelContact("facebook", "psid-123");
  assert.equal(contact.id, 91);
  assert.equal(contact.channel, "facebook");
  assert.equal(contact.channel_user_id, "psid-123");
});

test("social contact creation cannot be used for WhatsApp", async () => {
  await assert.rejects(
    contactsRepo.getOrCreateChannelContact("whatsapp", "60123456789"),
    /Unsupported social channel/
  );
});
