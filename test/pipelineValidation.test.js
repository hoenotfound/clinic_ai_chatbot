const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PipelineValidationError,
  normalizeLeadPayload,
  normalizeStagePayload,
  normalizeStageOrder,
} = require("../src/utils/pipelineValidation");

test("normalizes a complete lead payload", () => {
  const result = normalizeLeadPayload({
    contactId: "7",
    stageId: "3",
    temperature: "hot",
    branchName: "  Puchong  ",
    estimatedValue: "1288.50",
    appointmentStatus: "set",
    appointmentAt: "2026-09-02T11:00:00+08:00",
    marketingConsent: "opted_in",
  });

  assert.equal(result.contactId, 7);
  assert.equal(result.stageId, 3);
  assert.equal(result.branchName, "Puchong");
  assert.equal(result.estimatedValue, 1288.5);
  assert.equal(result.appointmentAt, "2026-09-02T03:00:00.000Z");
});

test("accepts explicit nulls in a partial lead update", () => {
  assert.deepEqual(
    normalizeLeadPayload(
      { branchName: null, estimatedValue: null, nextFollowUpAt: null },
      { partial: true }
    ),
    { branchName: null, estimatedValue: null, nextFollowUpAt: null }
  );
});

test("rejects invalid lead states and empty updates", () => {
  assert.throws(
    () => normalizeLeadPayload({ contactId: 7, temperature: "urgent" }),
    PipelineValidationError
  );
  assert.throws(
    () => normalizeLeadPayload({ contactId: 7, appointmentAt: "not-a-date" }),
    /Appointment date is invalid/
  );
  assert.throws(
    () => normalizeLeadPayload({}, { partial: true }),
    /No lead changes/
  );
});

test("validates custom stages and complete reorder payloads", () => {
  assert.deepEqual(normalizeStagePayload({ name: "  Review Quote  " }), {
    name: "Review Quote",
    color: "#2f6f62",
    stageType: "open",
  });
  assert.deepEqual(normalizeStageOrder({ stageIds: ["3", 1, 2] }), [3, 1, 2]);
  assert.throws(
    () => normalizeStageOrder({ stageIds: [1, 1] }),
    /contains duplicates/
  );
});
