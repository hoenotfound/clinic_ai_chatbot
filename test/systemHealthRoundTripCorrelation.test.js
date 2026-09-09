const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getMessagingMetrics,
} = require("../src/db/systemHealthRepo");

test("messaging health keeps operational recovery separate from exact AI readiness evidence", async () => {
  const seenSql = [];
  const queryable = {
    async query(sql, params = []) {
      seenSql.push(sql);
      if (sql.includes("FROM messaging_runtime_health")) {
        assert.deepEqual(params, []);
        return {
          rows: [
            // An unrelated successful social send is valid operational recovery
            // evidence, but must not become exact AI-reply readiness evidence.
            { channel: "instagram", last_outbound_accepted_at: "2026-09-08T10:00:09.000Z" },
            { channel: "facebook", last_outbound_accepted_at: "2026-09-08T10:00:08.000Z" },
          ],
        };
      }
      if (sql.includes("outbound_message_evidence")) {
        assert.deepEqual(params, []);
        return {
          rows: [
            {
              channel: "whatsapp",
              last_inbound_contact_id: 11,
              last_inbound_message_id: 101,
              last_inbound_at: "2026-09-08T10:00:00.000Z",
              last_verified_ai_reply_at: "2026-09-08T10:00:02.000Z",
              last_ai_reply_failure_at: null,
            },
            {
              channel: "instagram",
              last_inbound_contact_id: 22,
              last_inbound_message_id: 202,
              last_inbound_at: "2026-09-08T10:00:04.000Z",
              last_verified_ai_reply_at: null,
              last_ai_reply_failure_at: "2026-09-08T10:00:06.000Z",
            },
            {
              channel: "facebook",
              last_inbound_contact_id: 33,
              last_inbound_message_id: 303,
              last_inbound_at: "2026-09-08T10:00:04.000Z",
              last_verified_ai_reply_at: "2026-09-08T10:00:07.000Z",
              last_ai_reply_failure_at: null,
            },
          ],
        };
      }
      assert.deepEqual(params, [24]);
      return {
        rows: [
          {
            channel: "whatsapp",
            last_inbound_at: "2026-09-08T10:00:00.000Z",
            last_successful_outbound_at: "2026-09-08T10:00:03.000Z",
            recent_delivery_failures: 0,
            last_delivery_failure_at: null,
          },
          {
            channel: "instagram",
            last_inbound_at: "2026-09-08T10:00:04.000Z",
            last_successful_outbound_at: null,
            recent_delivery_failures: 1,
            last_delivery_failure_at: "2026-09-08T10:00:05.000Z",
          },
          {
            channel: "facebook",
            last_inbound_at: "2026-09-08T10:00:04.000Z",
            last_successful_outbound_at: null,
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

  assert.equal(whatsapp.lastSuccessfulOutboundAt.toISOString(), "2026-09-08T10:00:03.000Z");
  assert.equal(whatsapp.lastVerifiedAutomatedReplyAt, "2026-09-08T10:00:02.000Z");
  assert.equal(whatsapp.roundTripCorrelated, true);

  // Existing Setup Status still sees the unrelated accepted social send for
  // operational recovery, while readiness correctly has no accepted AI reply.
  assert.equal(instagram.lastSuccessfulOutboundAt.toISOString(), "2026-09-08T10:00:09.000Z");
  assert.equal(instagram.lastVerifiedAutomatedReplyAt, null);
  assert.equal(instagram.lastReadinessDeliveryFailureAt, "2026-09-08T10:00:06.000Z");
  assert.equal(instagram.roundTripCorrelated, false);

  assert.equal(facebook.lastSuccessfulOutboundAt.toISOString(), "2026-09-08T10:00:08.000Z");
  assert.equal(facebook.lastVerifiedAutomatedReplyAt, "2026-09-08T10:00:07.000Z");
  assert.equal(facebook.lastInboundContactId, 33);
  assert.equal(facebook.lastInboundMessageId, 303);
  assert.equal(facebook.roundTripCorrelated, true);

  const readinessSql = seenSql.find((sql) => sql.includes("outbound_message_evidence"));
  assert.ok(readinessSql);
  assert.match(readinessSql, /e\.message_id = reply\.id/);
  assert.match(readinessSql, /e\.contact_id = li\.contact_id/);
  assert.match(readinessSql, /e\.channel = li\.channel/);
  assert.match(readinessSql, /e\.origin = 'ai_reply'/);
  assert.match(readinessSql, /e\.accepted = true/);
});
