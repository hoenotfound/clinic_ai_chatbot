const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getInboundProcessingMetrics,
  getMessagingMetrics,
} = require("../src/db/systemHealthRepo");

test("inbound health metrics combine durable message and Meta-resolution queues", async () => {
  const queryable = {
    async query(sql, params = []) {
      if (/FROM inbound_processing_jobs/.test(sql)) {
        assert.match(sql, /terminal_at >= NOW\(\) - \(\$1::int \* interval '1 hour'\)/);
        assert.match(sql, /c\.needs_attention = true/);
        assert.deepEqual(params, [24]);
        return { rows: [{ pending_count: 1, processing_count: 2, retryable_failed_count: 0, terminal_count: 1, oldest_open_at: new Date("2026-09-05T00:01:00Z") }] };
      }
      if (/FROM inbound_meta_resolution_jobs/.test(sql)) {
        assert.match(sql, /terminal_at >= NOW\(\) - \(\$1::int \* interval '1 hour'\)/);
        assert.deepEqual(params, [24]);
        return { rows: [{ pending_count: 2, processing_count: 0, retryable_failed_count: 1, terminal_count: 0, oldest_open_at: new Date("2026-09-05T00:02:00Z") }] };
      }
      if (/FROM inbound_failure_events/.test(sql)) {
        assert.deepEqual(params, [24]);
        return { rows: [{ failed_jobs: 3 }] };
      }
      if (/FROM inbound_recovery_events/.test(sql)) {
        assert.deepEqual(params, [24]);
        return { rows: [{ restart_recoveries: 2 }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const metrics = await getInboundProcessingMetrics({ hours: 24 }, queryable);
  assert.equal(metrics.pendingCount, 3);
  assert.equal(metrics.processingCount, 2);
  assert.equal(metrics.retryableFailedCount, 1);
  assert.equal(metrics.failedJobs, 3);
  assert.equal(metrics.terminalFailures, 1);
  assert.equal(metrics.restartRecoveries, 2);
  assert.equal(metrics.oldestOpenAt.toISOString(), "2026-09-05T00:01:00.000Z");
});

test("messaging metrics preserve quiet channels and include accepted social outbound activity", async () => {
  const queryable = {
    async query(sql, params = []) {
      if (/FROM contacts c/.test(sql)) {
        assert.match(sql, /delivery_status = 'failed'/);
        assert.match(sql, /MAX\(m\.created_at\).*m\.role = 'user'/s);
        assert.deepEqual(params, [24]);
        return {
          rows: [{
            channel: "whatsapp",
            last_inbound_at: new Date("2026-09-05T00:00:00Z"),
            last_successful_outbound_at: new Date("2026-09-05T00:00:05Z"),
            recent_delivery_failures: 0,
            last_delivery_failure_at: null,
          }],
        };
      }
      if (/FROM messaging_runtime_health/.test(sql)) {
        assert.deepEqual(params, []);
        return {
          rows: [{
            channel: "instagram",
            last_outbound_accepted_at: new Date("2026-09-05T00:03:00Z"),
          }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const metrics = await getMessagingMetrics({ hours: 24 }, queryable);
  assert.equal(metrics.length, 3);
  assert.equal(metrics[0].channel, "whatsapp");
  assert.equal(metrics[0].recentDeliveryFailures, 0);
  assert.equal(metrics[1].channel, "instagram");
  assert.equal(metrics[1].lastInboundAt, null);
  assert.equal(
    metrics[1].lastSuccessfulOutboundAt.toISOString(),
    "2026-09-05T00:03:00.000Z"
  );
  assert.equal(metrics[2].channel, "facebook");
  assert.equal(metrics[2].lastSuccessfulOutboundAt, null);
});