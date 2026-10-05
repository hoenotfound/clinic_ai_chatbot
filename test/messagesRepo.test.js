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



test("detects a real staff reply after one specific inbound turn", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /staff\.sent_by_username IS NOT NULL/);
    assert.match(sql, /\(staff\.created_at, staff\.id\) > \(inbound\.created_at, inbound\.id\)/);
    assert.deepEqual(params, [42, 99]);
    return { rows: [{ has_staff_reply: true }] };
  };

  assert.equal(await messagesRepo.hasStaffReplyAfter(42, 99), true);
  assert.equal(await messagesRepo.hasStaffReplyAfter(null, 99), false);
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


test("result media duplicate lookup matches accepted media by URL for seven-day suppression", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /contact_id = \$1/);
    assert.match(sql, /media_url = \$2/);
    assert.doesNotMatch(sql, /content = \$3/);
    assert.match(sql, /whatsapp_message_id IS NOT NULL/);
    assert.match(sql, /delivery_status NOT IN \('failed', 'unknown'\)/);
    assert.match(sql, /\$3::integer \* INTERVAL '1 hour'/);
    assert.deepEqual(params, [42, "https://example.test/result.jpg", 168]);
    return { rowCount: 1, rows: [] };
  };

  assert.equal(
    await messagesRepo.wasMediaRecentlySent(
      42,
      "https://example.test/result.jpg",
      168
    ),
    true
  );
});

test("result media duplicate lookup fails open for invalid inputs without querying Postgres", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let queried = false;
  pool.query = async () => {
    queried = true;
    return { rowCount: 0, rows: [] };
  };

  assert.equal(await messagesRepo.wasMediaRecentlySent(42, "", 168), false);
  assert.equal(
    await messagesRepo.wasMediaRecentlySent(
      42,
      "https://example.test/result.jpg",
      0
    ),
    false
  );
  assert.equal(queried, false);
});


test("result media rotation history returns the most recently accepted configured URL", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /media_url = ANY\(\$2::text\[\]\)/);
    assert.match(sql, /whatsapp_message_id IS NOT NULL/);
    assert.match(sql, /delivery_status NOT IN \('failed', 'unknown'\)/);
    assert.match(sql, /ORDER BY created_at DESC, id DESC/);
    assert.deepEqual(params, [
      42,
      [
        "https://example.test/result-1.jpg",
        "https://example.test/result-2.jpg",
      ],
    ]);
    return {
      rows: [{ media_url: "https://example.test/result-2.jpg" }],
    };
  };

  assert.equal(
    await messagesRepo.getMostRecentlySentMediaUrl(
      42,
      [
        "https://example.test/result-1.jpg",
        "https://example.test/result-2.jpg",
        "https://example.test/result-2.jpg",
      ]
    ),
    "https://example.test/result-2.jpg"
  );
});

test("result media rotation history fails closed without a contact or URLs", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let queried = false;
  pool.query = async () => {
    queried = true;
    return { rows: [] };
  };

  assert.equal(await messagesRepo.getMostRecentlySentMediaUrl(null, ["x"]), null);
  assert.equal(await messagesRepo.getMostRecentlySentMediaUrl(42, []), null);
  assert.equal(queried, false);
});


test("result media cooldown treats legacy public and private stored paths as the same image", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /promo-images/);
    assert.match(sql, /api\/config\/result-media\/image/);
    assert.deepEqual(params, [
      42,
      "/api/config/result-media/image/321",
      168,
      321,
    ]);
    return { rowCount: 1, rows: [] };
  };

  assert.equal(
    await messagesRepo.wasMediaRecentlySent(
      42,
      "/api/config/result-media/image/321",
      168
    ),
    true
  );
});

test("result media rotation history can find a legacy public path for a private configured image", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /unnest\(\$3::int\[\]\)/);
    assert.match(sql, /promo-images/);
    assert.match(sql, /api\/config\/result-media\/image/);
    assert.deepEqual(params, [
      42,
      [
        "/api/config/result-media/image/321",
        "/api/config/result-media/image/322",
      ],
      [321, 322],
    ]);
    return {
      rows: [{ media_url: "https://old.example/promo-images/321" }],
    };
  };

  assert.equal(
    await messagesRepo.getMostRecentlySentMediaUrl(
      42,
      [
        "/api/config/result-media/image/321",
        "/api/config/result-media/image/322",
      ]
    ),
    "https://old.example/promo-images/321"
  );
});


test("stores a WhatsApp reaction against the referenced message without creating a new message", async (t) => {
  const originalConnect = pool.connect;
  t.after(() => {
    pool.connect = originalConnect;
  });

  const queries = [];
  let released = false;
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (/WITH candidates AS/.test(text)) {
        return { rows: [{ id: 91, contact_id: 7 }] };
      }
      if (/SELECT id, reactor_key, reactor_whatsapp_id/.test(text)) {
        return { rows: [] };
      }
      if (/INSERT INTO message_reactions/.test(text)) {
        return { rows: [{ id: 501 }] };
      }
      if (/AS reactions/.test(text)) {
        return { rows: [{ reactions: [{ emoji: "❤️" }] }] };
      }
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };
  pool.connect = async () => client;

  const updated = await messagesRepo.applyWhatsappReaction({
    id: "reaction-event-1",
    from: "60123456789",
    targetMessageId: "wamid-target-1",
    emoji: "❤️",
    timestamp: "1791196800",
  });

  assert.deepEqual(updated, {
    contactId: 7,
    messageId: 91,
    reactions: [{ emoji: "❤️" }],
    changed: true,
  });
  assert.equal(released, true);

  const targetLookup = queries.find((call) => /WITH candidates AS/.test(call.sql));
  assert.ok(targetLookup);
  assert.deepEqual(targetLookup.params, ["wamid-target-1"]);
  assert.match(targetLookup.sql, /outbound_message_evidence/);
  assert.match(targetLookup.sql, /inbound_outbound_attempts/);

  const insert = queries.find((call) => /INSERT INTO message_reactions/.test(call.sql));
  assert.ok(insert);
  assert.match(insert.sql, /ON CONFLICT \(target_message_id, reactor_key\)/);
  assert.match(insert.sql, /provider_timestamp/);
  assert.deepEqual(insert.params.slice(0, 6), [
    91,
    7,
    "whatsapp:60123456789",
    "❤️",
    "reaction-event-1",
    1791196800,
  ]);
  assert.ok(insert.params[6] instanceof Date);
  assert.equal(
    queries.some((call) => /INSERT INTO messages\s*\(/.test(call.sql)),
    false,
    "a reaction must never create a conversational message row"
  );
});

test("reaction removal is retained as an ordered tombstone instead of being deleted", async (t) => {
  const originalConnect = pool.connect;
  t.after(() => {
    pool.connect = originalConnect;
  });

  const queries = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (/WITH candidates AS/.test(text)) {
        return { rows: [{ id: 92, contact_id: 8 }] };
      }
      if (/SELECT id, reactor_key, reactor_whatsapp_id/.test(text)) {
        return { rows: [] };
      }
      if (/INSERT INTO message_reactions/.test(text)) {
        return { rows: [{ id: 502 }] };
      }
      if (/AS reactions/.test(text)) {
        return { rows: [{ reactions: [] }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  const updated = await messagesRepo.applyWhatsappReaction({
    id: "reaction-remove-1",
    from: "60180000000",
    targetMessageId: "wamid-target-2",
    emoji: "",
    timestamp: "1791196801",
  });

  assert.deepEqual(updated, {
    contactId: 8,
    messageId: 92,
    reactions: [],
    changed: true,
  });

  const insert = queries.find((call) => /INSERT INTO message_reactions/.test(call.sql));
  assert.ok(insert);
  assert.equal(insert.params[3], "");
  assert.equal(insert.params[5], 1791196801);
  assert.match(insert.sql, /EXCLUDED\.provider_timestamp >= message_reactions\.provider_timestamp/);
  assert.equal(
    queries.some((call) => /DELETE FROM message_reactions/.test(call.sql)),
    false,
    "reaction removal must keep a tombstone so an older retry cannot resurrect it"
  );
});

test("queues a WhatsApp reaction durably when the referenced WAMID is not available yet", async (t) => {
  const originalConnect = pool.connect;
  t.after(() => {
    pool.connect = originalConnect;
  });

  const queries = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (/WITH candidates AS/.test(text)) {
        return { rows: [] };
      }
      if (/INSERT INTO pending_whatsapp_reactions/.test(text)) {
        return { rows: [{ id: 601 }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  const updated = await messagesRepo.applyWhatsappReaction({
    id: "reaction-pending-1",
    from: "60181112222",
    targetMessageId: "wamid-not-local-yet",
    emoji: "👍",
    timestamp: "1791196802",
  });

  assert.deepEqual(updated, {
    pending: true,
    targetMessageId: "wamid-not-local-yet",
    changed: true,
  });

  const pendingInsert = queries.find((call) =>
    /INSERT INTO pending_whatsapp_reactions/.test(call.sql)
  );
  assert.ok(pendingInsert);
  assert.deepEqual(pendingInsert.params.slice(0, 6), [
    "wamid-not-local-yet",
    "whatsapp:60181112222",
    "60181112222",
    "👍",
    "reaction-pending-1",
    1791196802,
  ]);
  assert.ok(pendingInsert.params[6] instanceof Date);
});

test("reconciles a pending WhatsApp reaction after the target message receives its WAMID", async (t) => {
  const originalConnect = pool.connect;
  t.after(() => {
    pool.connect = originalConnect;
  });

  const queries = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (/FROM messages\s+WHERE id = \$1\s+AND whatsapp_message_id = \$2/.test(text)) {
        return { rows: [{ id: 93, contact_id: 9 }] };
      }
      if (/SELECT id, reactor_key, reactor_whatsapp_id/.test(text)) {
        return {
          rows: [
            {
              id: 701,
              reactor_key: "whatsapp:60182223333",
              reactor_whatsapp_id: "60182223333",
              emoji: "😂",
              provider_reaction_message_id: "reaction-pending-2",
              provider_timestamp: "1791196803",
              received_at: new Date("2026-10-05T09:00:00Z"),
              updated_at: new Date("2026-10-05T09:00:00Z"),
            },
          ],
        };
      }
      if (/INSERT INTO message_reactions/.test(text)) {
        return { rows: [{ id: 503 }] };
      }
      if (/AS reactions/.test(text)) {
        return { rows: [{ reactions: [{ emoji: "😂" }] }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  const updated = await messagesRepo.reconcilePendingWhatsappReactionsForMessage(
    93,
    "wamid-late-target"
  );

  assert.deepEqual(updated, {
    contactId: 9,
    messageId: 93,
    reactions: [{ emoji: "😂" }],
    changed: true,
  });

  assert.ok(
    queries.some((call) =>
      /DELETE FROM pending_whatsapp_reactions/.test(call.sql)
    )
  );
  const reactionInsert = queries.find((call) =>
    /INSERT INTO message_reactions/.test(call.sql)
  );
  assert.equal(reactionInsert.params[5], 1791196803);
});

test("Inbox message pages include only active reaction metadata", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /FROM message_reactions mr/);
    assert.match(sql, /mr\.target_message_id = messages\.id/);
    assert.match(sql, /mr\.emoji <> ''/);
    assert.deepEqual(params, [7, 51]);
    return {
      rows: [
        {
          id: 101,
          role: "assistant",
          content: "Photo",
          reactions: [{ emoji: "👍" }],
        },
      ],
    };
  };

  const page = await messagesRepo.getMessagePageForContact(7, { limit: 50 });
  assert.deepEqual(page.rows[0].reactions, [{ emoji: "👍" }]);
});
