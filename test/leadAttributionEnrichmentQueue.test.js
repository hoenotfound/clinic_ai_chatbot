const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createLeadAttributionService,
} = require("../src/services/leadAttributionService");

test("Meta Ads first-touch capture queues enrichment after the row is durable", async () => {
  const calls = [];
  const repo = {
    async createFirstTouch(payload) {
      calls.push(["saved", payload.leadId]);
      return {
        id: 77,
        lead_id: payload.leadId,
        enrichment_status: "pending",
      };
    },
  };
  const events = {
    publish(type, payload) {
      calls.push(["event", type, payload.reason]);
    },
  };
  const enrichment = {
    queueAttributionEnrichment(id) {
      calls.push(["queued", id]);
      return true;
    },
  };
  const service = createLeadAttributionService(repo, events, enrichment);

  const saved = await service.captureForInbound({
    lead: { id: 44 },
    firstMessageId: 101,
    incoming: {
      channel: "whatsapp",
      from: "60120000000",
      attribution: {
        source: "meta_ads",
        channel: "whatsapp",
        adId: "120210000001234",
      },
    },
  });

  assert.equal(saved.id, 77);
  assert.deepEqual(calls, [
    ["saved", 44],
    ["event", "pipeline_changed", "lead_attribution_captured"],
    ["queued", 77],
  ]);
});

test("non-ad attribution does not enter the Meta enrichment queue", async () => {
  let queued = false;
  const service = createLeadAttributionService(
    {
      async createFirstTouch() {
        return { id: 78, lead_id: 45, enrichment_status: "not_applicable" };
      },
    },
    { publish() {} },
    {
      queueAttributionEnrichment() {
        queued = true;
      },
    }
  );

  await service.captureForInbound({
    lead: { id: 45 },
    firstMessageId: 102,
    incoming: {
      channel: "whatsapp",
      from: "60120000001",
    },
  });

  assert.equal(queued, false);
});
