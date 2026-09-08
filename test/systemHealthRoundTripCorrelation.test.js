const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getMessagingMetrics,
  socialRoundTripAccepted,
} = require("../src/db/systemHealthRepo");

test("social round-trip acceptance requires provider acceptance after the same-contact reply candidate", () => {
  assert.equal(
    socialRoundTripAccepted("2026-09-08T10:00:05.000Z", "2026-09-08T10:00:06.000Z").toISOString(),
    "2026-09-08T10:00:05.000Z"
  );
  assert.equal(
    socialRoundTripAccepted("2026-09-08T10:00:05.000Z", "2026-09-08T10:00:04.000Z"),
    null
  );
  assert.equal(socialRoundTripAccepted(null, "2026-09-08T10:00:06.000Z"), null);
});

test("messaging health query ties the reply candidate to the latest inbound contact", async () => {
  const seenSql = [];
  const queryable = {
    async query(sql) {
      seenSql.push(sql);
      if (sql.includes("FROM messaging_runtime_health")) {
        return {
          rows: [
            { channel: "instagram", last_outbound_accepted_at: "2026-09-08T10:00:07.000Z" },
            { channel: "facebook", last_outbound_accepted_at: "2026-09-08T10:00:03.000Z" },
          ],
        };
      }
      return {
        rows: [
          {
            channel: "whatsapp",
            last_inbound_contact_id: 11,
            last_inbound_message_id: 101,
            last_inbound_at: "2026-09-08T10:00:00.000Z",
            last_correlated_outbound_at: "2026-09-08T10:00:02.000Z",
            recent_delivery_failures: 0,
            last_delivery_failure_at: null,
          },
          {
            channel: "instagram",
            last_inbound_contact_id: 22,
            last_inbound_message_id: 202,
            last_inbound_at: "2026-09-08T10:00:04.000Z",
            last_correlated_outbound_at: "2026-09-08T10:00:06.000Z",
            recent_delivery_failures: 0,
            last_delivery_failure_at: null,
          },
          {
            channel: "facebook",
            last_inbound_contact_id: 33,
            last_inbound_message_id: 303,
            last_inbound_at: "2026-09-08T10:00:04.000Z",
            last_correlated_outbound_at: "2026-09-08T10:00:05.000Z",
            recent_delivery_failures: 0,
            last_delivery_failure_at: null,
          },
        ],
      };
    },
  };

  const metrics = await getMessagingMetrics({ hours: 24 }, queryable);
  const whatsapp = metrics.find((item) => item.channel === "whatsapp");
  const instagram = metrics.find((item) => item.channel === "instagram");
  const facebook = metrics.find((item) => item.channel === "facebook");

  assert.equal(whatsapp.lastInboundContactId, 11);
  assert.equal(whatsapp.lastInboundMessageId, 101);
  assert.equal(whatsapp.lastSuccessfulOutboundAt.toISOString(), "2026-09-08T10:00:02.000Z");
  assert.equal(whatsapp.roundTripCorrelated, true);

  assert.equal(instagram.lastInboundContactId, 22);
  assert.equal(instagram.lastSuccessfulOutboundAt.toISOString(), "2026-09-08T10:00:06.000Z");
  assert.equal(instagram.roundTripCorrelated, true);

  assert.equal(facebook.lastSuccessfulOutboundAt, null);
  assert.equal(facebook.roundTripCorrelated, false);

  const correlationSql = seenSql.find((sql) => sql.includes("WITH latest_inbound"));
  assert.ok(correlationSql);
  assert.match(correlationSql, /m\.contact_id = li\.contact_id/);
  assert.match(correlationSql, /m\.created_at > li\.last_inbound_at/);
  assert.match(correlationSql, /m\.sent_by_username IS NULL/);
  assert.match(correlationSql, /is_automated_follow_up/);
});
