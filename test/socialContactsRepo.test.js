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
      assert.match(sql, /LEFT JOIN LATERAL/);
      assert.match(sql, /AS latest_inbound_at/);
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
    assert.match(sql, /whatsapp_profile_name = COALESCE\(\$1::text, whatsapp_profile_name\)/);
    assert.match(sql, /photo_url = COALESCE\(\$2::text, photo_url\)/);
    assert.match(sql, /\$1::text IS NOT NULL/);
    assert.match(sql, /\$2::text IS NOT NULL/);
    assert.match(sql, /photo_url IS DISTINCT FROM \$2::text/);
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

test("Contacts directory also hides social storage keys", async (t) => {
  const originalQuery = pool.query;
  const originalFetchProfile = metaMessaging.fetchUserProfile;
  t.after(() => {
    pool.query = originalQuery;
    metaMessaging.fetchUserProfile = originalFetchProfile;
  });

  pool.query = async (sql) => {
    assert.match(sql, /LEFT JOIN messages/);
    return {
      rows: [
        {
          id: 93,
          whatsapp_number: "facebook:psid-directory",
          name: null,
          whatsapp_profile_name: "Directory User",
          channel: "facebook",
          channel_user_id: "psid-directory",
          photo_url: "https://example.test/current.jpg",
          message_count: 2,
        },
      ],
    };
  };

  metaMessaging.fetchUserProfile = async () => ({
    profileName: "Directory User",
    photoUrl: "https://example.test/current.jpg",
    username: null,
  });

  const contacts = await contactsRepo.listContacts();
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].whatsapp_number, "Facebook Messenger");
  assert.equal(contacts[0].whatsapp_profile_name, "Directory User");
  assert.equal(contacts[0].channel_user_id, "psid-directory");
});

test("refreshes an existing Instagram profile photo without overwriting a staff name", async (t) => {
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
      return {
        rows: [
          {
            id: 94,
            whatsapp_number: "instagram:igsid-refresh",
            name: "Clinic nickname",
            whatsapp_profile_name: "Old platform name",
            channel: "instagram",
            channel_user_id: "igsid-refresh",
            photo_url: "https://example.test/old.jpg",
            message_count: 1,
          },
        ],
      };
    }

    assert.equal(queryCount, 2);
    assert.match(sql, /UPDATE contacts/);
    assert.deepEqual(params, [
      "New platform name",
      "https://example.test/new.jpg",
      94,
    ]);
    return {
      rows: [
        {
          whatsapp_profile_name: "New platform name",
          photo_url: "https://example.test/new.jpg",
          updated_at: "2026-08-31T09:00:00.000Z",
        },
      ],
    };
  };

  metaMessaging.fetchUserProfile = async () => ({
    profileName: "New platform name",
    photoUrl: "https://example.test/new.jpg",
    username: "newusername",
  });

  const contacts = await contactsRepo.listContacts();
  assert.equal(queryCount, 2);
  assert.equal(contacts[0].name, "Clinic nickname");
  assert.equal(contacts[0].whatsapp_profile_name, "New platform name");
  assert.equal(contacts[0].photo_url, "https://example.test/new.jpg");
});

test("editing a social contact name never changes its channel identifier", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /SET name = \$1/);
    assert.doesNotMatch(sql, /whatsapp_number =/);
    assert.deepEqual(params, ["Preferred Name", 95]);
    return {
      rows: [
        {
          id: 95,
          name: "Preferred Name",
          whatsapp_number: "facebook:psid-safe",
          channel: "facebook",
          channel_user_id: "psid-safe",
        },
      ],
    };
  };

  const updated = await contactsRepo.updateContactName(95, "Preferred Name");
  assert.equal(updated.name, "Preferred Name");
  assert.equal(updated.whatsapp_number, "facebook:psid-safe");
  assert.equal(updated.channel_user_id, "psid-safe");
});
