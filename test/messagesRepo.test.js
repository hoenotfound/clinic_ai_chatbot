const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const { CONVERSATION_LOCK_NAMESPACE } = require("../src/db/conversationLock");
const messagesRepo = require("../src/db/messagesRepo");
const mediaStorage = require("../src/services/mediaStorageService");

test("claims an inbound WhatsApp message with an atomic insert", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, new RegExp(`pg_advisory_xact_lock\\(${CONVERSATION_LOCK_NAMESPACE}`));
    assert.match(sql, /ON CONFLICT \(whatsapp_message_id\) DO NOTHING/);
    assert.deepEqual(params, [7, "Hello", "wamid-inbound", null, null]);
    return { rows: [{ id: 41, contact_id: 7, content: "Hello" }] };
  };

  const claimed = await messagesRepo.saveInboundMessageIfNew(
    7,
    "Hello",
    "wamid-inbound"
  );
  assert.equal(claimed.id, 41);
});

test("returns null when another webhook already claimed the message", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({ rows: [] });
  const claimed = await messagesRepo.saveInboundMessageIfNew(
    7,
    "Hello",
    "wamid-inbound"
  );
  assert.equal(claimed, null);
});

test("outbound message writes take the conversation scoring lock", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, new RegExp(`pg_advisory_xact_lock\\(${CONVERSATION_LOCK_NAMESPACE}`));
    assert.match(sql, /FROM conversation_lock/);
    assert.deepEqual(params, [7, "assistant", "Hello", null, null, null, null, null]);
    return { rows: [{ id: 42, contact_id: 7, content: "Hello" }] };
  };

  const saved = await messagesRepo.saveMessage(7, "assistant", "Hello");
  assert.equal(saved.id, 42);
});

test("uploads Buffer attachments to R2 without a base64 round-trip", async (t) => {
  const originalQuery = pool.query;
  const originalUploadMedia = mediaStorage.uploadMedia;
  t.after(() => {
    pool.query = originalQuery;
    mediaStorage.uploadMedia = originalUploadMedia;
  });

  const attachment = Buffer.from([0, 1, 2, 3, 254, 255]);
  mediaStorage.uploadMedia = async (buffer, mimeType, options) => {
    assert.strictEqual(buffer, attachment);
    assert.equal(mimeType, "image/jpeg");
    assert.deepEqual(options, { contactId: 7 });
    return "messages/7/direct-buffer.jpg";
  };

  pool.query = async (sql, params) => {
    assert.match(sql, /INSERT INTO messages/);
    assert.deepEqual(params, [
      7,
      "assistant",
      "Photo",
      null,
      "staff",
      null,
      "messages/7/direct-buffer.jpg",
      "image/jpeg",
    ]);
    return { rows: [{ id: 43, contact_id: 7, content: "Photo" }] };
  };

  const saved = await messagesRepo.saveMessage(
    7,
    "assistant",
    "Photo",
    null,
    "staff",
    null,
    attachment,
    "image/jpeg"
  );
  assert.equal(saved.id, 43);
});

test("inbound transcript updates take the conversation scoring lock", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, new RegExp(`pg_advisory_xact_lock\\(${CONVERSATION_LOCK_NAMESPACE}`));
    assert.match(sql, /UPDATE messages/);
    assert.deepEqual(params, [42, 7, "Updated", null, null]);
    return { rows: [{ id: 42, contact_id: 7, content: "Updated" }] };
  };

  const saved = await messagesRepo.updateInboundMessage(42, 7, "Updated", null, null);
  assert.equal(saved.content, "Updated");
});

test("returns an R2 media reference without downloading the attachment", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /SELECT media_key, media_mime_type/);
    assert.match(sql, /media_key IS NOT NULL/);
    assert.deepEqual(params, [42, 7]);
    return {
      rows: [
        {
          media_key: "messages/7/example.ogg",
          media_mime_type: "audio/ogg",
        },
      ],
    };
  };

  const media = await messagesRepo.getMessageMediaReferenceForContact(7, 42);
  assert.deepEqual(media, {
    media_key: "messages/7/example.ogg",
    media_mime_type: "audio/ogg",
  });
});

test("outbound WhatsApp template metadata is stored atomically with the message", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /whatsapp_template/);
    assert.match(sql, /delivery_status, delivery_error/);
    assert.match(sql, /\$9::jsonb, \$10, \$11/);
    assert.deepEqual(JSON.parse(params[8]), {
      name: "lead_follow_up",
      language: "en_US",
      category: "MARKETING",
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: "Alex" }],
        },
      ],
    });
    assert.equal(params[9], "unknown");
    assert.equal(params[10], "Template send started");
    return {
      rows: [{
        id: 44,
        contact_id: 7,
        content: "Hi Alex",
        whatsapp_template: JSON.parse(params[8]),
      }],
    };
  };

  const saved = await messagesRepo.saveMessage(
    7,
    "assistant",
    "Hi Alex",
    null,
    "staff",
    null,
    null,
    null,
    {
      whatsappTemplate: {
        name: "lead_follow_up",
        language: "en_US",
        category: "MARKETING",
        components: [
          {
            type: "body",
            parameters: [{ type: "text", text: "Alex" }],
          },
        ],
      },
      initialDeliveryStatus: "unknown",
      initialDeliveryError: "Template send started",
    }
  );

  assert.equal(saved.whatsapp_template.name, "lead_follow_up");
});



test("promo duplicate lookup counts only provider-accepted non-failed media sends", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let call = 0;
  pool.query = async (sql, params) => {
    call += 1;
    assert.match(sql, /contact_id = \$1/);
    assert.match(sql, /media_url = \$2/);
    assert.match(sql, /content = \$3/);
    assert.match(sql, /whatsapp_message_id IS NOT NULL/);
    assert.match(sql, /delivery_status NOT IN \('failed', 'unknown'\)/);
    assert.match(sql, /\$4::integer \* INTERVAL '1 hour'/);
    assert.deepEqual(params, [42, "https://example.test/promo.jpg", "Promo caption", 24]);
    return { rowCount: call === 1 ? 1 : 0, rows: [] };
  };

  assert.equal(
    await messagesRepo.wasPromoRecentlySent(
      42,
      "https://example.test/promo.jpg",
      "Promo caption",
      24
    ),
    true
  );
  assert.equal(
    await messagesRepo.wasPromoRecentlySent(
      42,
      "https://example.test/promo.jpg",
      "Promo caption",
      24
    ),
    false
  );
});

test("promo duplicate lookup fails open for invalid lookup inputs without querying Postgres", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let queried = false;
  pool.query = async () => {
    queried = true;
    return { rowCount: 0, rows: [] };
  };

  assert.equal(await messagesRepo.wasPromoRecentlySent(42, "", "Promo caption", 24), false);
  assert.equal(
    await messagesRepo.wasPromoRecentlySent(
      42,
      "https://example.test/promo.jpg",
      "Promo caption",
      0
    ),
    false
  );
  assert.equal(queried, false);
});
