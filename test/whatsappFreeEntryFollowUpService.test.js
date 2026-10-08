const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const clinicConfig = require("../src/config/clinicConfig");
const worker = require("../src/services/whatsappFreeEntryFollowUpService");

test("extended follow-up requires both global kill switch and clinic enable", () => {
  const old = clinicConfig.automatedFollowUp;
  try {
    clinicConfig.automatedFollowUp = {
      enabled: true,
      freeEntry: {
        enabled: true,
        activatedAt: "2026-10-08T00:00:00Z",
        templateName: "lead_follow_up",
        language: "zh_CN",
        slotsHours: [36, 60, 84, 108, 132, 156],
      },
    };
    assert.equal(worker.settings({}), null);
    const active = worker.settings({ WHATSAPP_FEP_FOLLOWUPS_ENABLED: "true" });
    assert.equal(active?.templateName, "lead_follow_up");
    assert.deepEqual(active?.slots, [36,60,84,108,132,156]);
    clinicConfig.automatedFollowUp.freeEntry.enabled = false;
    assert.equal(worker.settings({ WHATSAPP_FEP_FOLLOWUPS_ENABLED: "true" }), null);
  } finally {
    clinicConfig.automatedFollowUp = old;
  }
});

test("a silent lead gets one eligible day slot, never batches older reminders", () => {
  const candidate = {
    first_inbound_at: "2026-10-01T00:00:00Z",
    first_reply_at: "2026-10-01T00:02:00Z",
    last_inbound_at: "2026-10-01T00:00:00Z",
    source_is_ctwa: true,
    evidence_type: "free_entry_point",
  };
  assert.equal(worker.selectedSlot(candidate, [36,60,84], new Date("2026-10-02T12:05:00Z")), 36);
  assert.equal(worker.selectedSlot(candidate, [36,60,84], new Date("2026-10-03T13:00:00Z")), 60);
  assert.equal(worker.selectedSlot({ ...candidate, evidence_type: null }, [36,60,84], new Date("2026-10-03T13:00:00Z")), null);
  assert.equal(worker.selectedSlot({ ...candidate, last_inbound_at: "2026-10-02T14:00:00Z" }, [36,60,84], new Date("2026-10-03T13:00:00Z")), null);
});

test("worker has durable attempt, marketing and billed-message safety guards", () => {
  const code = fs.readFileSync(path.join(__dirname, "../src/services/whatsappFreeEntryFollowUpService.js"), "utf8");
  assert.match(code, /ON CONFLICT \(first_reply_message_id, slot_hours\) DO NOTHING/);
  assert.match(code, /lead\.marketing_consent = 'opted_in'/);
  assert.match(code, /evidence\.pricing_type = 'free_entry_point'/);
  assert.match(code, /prior_billing\\.billable IS DISTINCT FROM false/);
  assert.match(code, /quietHoursStatus/);
  assert.match(code, /checkTemplateAllowed|sendApprovedTemplate/);
  assert.match(code, /item.category === "MARKETING"/);
});
