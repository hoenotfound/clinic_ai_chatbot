const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const contactsRepo = require("../src/db/contactsRepo");
const metaMessaging = require("../src/services/metaMessagingService");

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

test("hydrates a Facebook contact profile and never exposes its internal key as a phone number", async (t) => {
  const originalQuery = pool.query;
  const originalFetchProfile = metaMessaging.fetchUserProfile;
  t.after(() => {
    pool.query = originalQuery;
    metaMessaging.fetchUserProfile = originalFetchProfile;
  });

  let queryCount = 0;
  pool.query = async (sql, params) => {
    queryCount += 1;
    if (queryCount === 1) {
      assert.match(sql, /FROM contacts c/);
      assert.match(sql, /JOIN messages m/);
      return {
        rows: [
          {
            contact_id: 91,
            whatsapp_number: "facebook:psid-123",
            name: null,
            whatsapp_profile_name: null,
            channel: "facebook",
            channel_user_id: "psid-123",
            photo_url: null,
            last_message: "Hello",
          },
        ],
      };
    }

    assert.equal(queryCount, 2);
    assert.match(sql, /UPDATE contacts/);
    assert.match(sql, /whatsapp_profile_name = COALESCE/);
    assert.deepEqual(params, [
      "Deon Tan",
      "https://example.test/deon.jpg",
      91,
    ]);
    return {
      rows: [
        {
          whatsapp_profile_name: "Deon Tan",
          photo_url: "https://example.test/deon.jpg",
          updated_at: "2026-08-31T08:00:00.000Z",
        },
      ],
    };
  };

  metaMessaging.fetchUserProfile = async (channel, userId) => {
    assert.equal(channel, "facebook");
    assert.equal(userId, "psid-123");
    return {
      profileName: "Deon Tan",
      photoUrl: "https://example.test/deon.jpg",
      username: null,
    };
  };

  const conversations = await contactsRepo.listConversations();
  assert.equal(queryCount, 2);
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].whatsapp_profile_name, "Deon Tan");
  assert.equal(conversations[0].whatsapp_number, "Facebook Messenger");
  assert.equal(conversations[0].channel_user_id, "psid-123");
  assert.equal(conversations[0].photo_url, "https://example.test/deon.jpg");
});

test("Instagram uses a safe channel label and fallback name when profile lookup is unavailable", async (t) => {
  const originalQuery = pool.query;
  const originalFetchProfile = metaMessaging.fetchUserProfile;
  t.after(() => {
    pool.query = originalQuery;
    metaMessaging.fetchUserProfile = originalFetchProfile;
  });

  pool.query = async (sql) => {
    assert.match(sql, /FROM contacts c/);
    return {
      rows: [
        {
          contact_id: 92,
          whatsapp_number: "instagram:igsid-456",
          name: null,
          whatsapp_profile_name: null,
          channel: "instagram",
          channel_user_id: "igsid-456",
          photo_url: null,
          last_message: "Hi",
        },
      ],
    };
  };

  metaMessaging.fetchUserProfile = async (channel, userId) => {
    assert.equal(channel, "instagram");
    assert.equal(userId, "igsid-456");
    return null;
  };

  const conversations = await contactsRepo.listConversations();
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].whatsapp_number, "Instagram");
  assert.equal(conversations[0].whatsapp_profile_name, "Instagram user");
  assert.equal(conversations[0].channel_user_id, "igsid-456");
});
