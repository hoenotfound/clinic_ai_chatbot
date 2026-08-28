const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const form = {
  stageId: "2",
  temperature: "warm",
  temperatureLocked: false,
  branchName: "Puchong",
  ownerUsername: "",
  treatmentInterest: "HIFU",
  estimatedValue: "1200",
  source: "WhatsApp",
  campaignName: "",
  appointmentStatus: "none",
  appointmentAt: "",
  nextFollowUpAt: "",
  lostReason: "",
  marketingConsent: "unknown",
  notes: "Call tomorrow",
};

test("lead detail saves omit temperature unless staff changed its controls", async () => {
  const { buildLeadUpdatePayload } = await import(
    "../portal-frontend/src/components/pipeline/pipelineUtils.js"
  );

  const ordinarySave = buildLeadUpdatePayload(form);
  assert.equal(Object.hasOwn(ordinarySave, "temperature"), false);
  assert.equal(Object.hasOwn(ordinarySave, "temperatureLocked"), false);
  assert.equal(ordinarySave.branchName, "Puchong");

  const temperatureSave = buildLeadUpdatePayload(form, { includeTemperature: true });
  assert.equal(temperatureSave.temperature, "warm");
  assert.equal(temperatureSave.temperatureLocked, false);
});

test("lead detail saves include only fields edited in the open drawer", async () => {
  const { buildLeadUpdatePayload } = await import(
    "../portal-frontend/src/components/pipeline/pipelineUtils.js"
  );

  const notesOnly = buildLeadUpdatePayload(form, {
    dirtyFields: new Set(["notes"]),
  });
  assert.deepEqual(notesOnly, { notes: "Call tomorrow" });

  const lockOnly = buildLeadUpdatePayload(form, {
    dirtyFields: new Set(["temperatureLocked"]),
  });
  assert.deepEqual(lockOnly, { temperatureLocked: false });
});

test("stage refreshes preserve local edits and ordering while merging live data", async () => {
  const { mergeStageDrafts, toStageDraft } = await import(
    "../portal-frontend/src/components/pipeline/pipelineUtils.js"
  );
  const original = [
    { id: 1, name: "New Lead", color: "#111111", stage_type: "open", lead_count: 1, system_key: "new" },
    { id: 2, name: "Contacted", color: "#222222", stage_type: "open", lead_count: 2, system_key: "contacted" },
  ];
  const drafts = original.map(toStageDraft).reverse();
  drafts[1] = { ...drafts[1], name: "Fresh Leads" };
  const refreshed = [
    { ...original[0], color: "#aaaaaa", lead_count: 4 },
    { ...original[1], name: "Reached", lead_count: 3 },
    { id: 3, name: "Custom", color: "#333333", stage_type: "open", lead_count: 0, system_key: null },
  ];

  const merged = mergeStageDrafts(
    refreshed,
    drafts,
    { 1: ["name"] },
    true
  );

  assert.deepEqual(merged.map((stage) => stage.id), [2, 1, 3]);
  assert.equal(merged[0].name, "Reached");
  assert.equal(merged[1].name, "Fresh Leads");
  assert.equal(merged[1].color, "#aaaaaa");
  assert.equal(merged[1].leadCount, 4);
});

test("time-based pipeline states update from an explicit clock", async () => {
  const { formatRelative, isNoReply, isOverdue } = await import(
    "../portal-frontend/src/components/pipeline/pipelineUtils.js"
  );
  const now = Date.parse("2026-08-28T12:00:00.000Z");
  const lead = {
    is_closed: false,
    last_message_role: "assistant",
    last_message_delivery_status: "delivered",
    last_message_at: "2026-08-27T11:59:00.000Z",
    next_follow_up_at: "2026-08-28T11:59:00.000Z",
  };

  assert.equal(isNoReply(lead, 24, now), true);
  assert.equal(isNoReply({ ...lead, last_message_delivery_status: "failed" }, 24, now), false);
  assert.equal(isNoReply({ ...lead, last_message_at: null }, 24, now), false);
  assert.equal(isOverdue(lead, now), true);
  assert.equal(formatRelative("2026-08-28T11:30:00.000Z", now), "30m ago");
});

test("pipeline refreshes when messages and delivery states change", () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "portal-frontend",
      "src",
      "pages",
      "Pipeline.jsx"
    ),
    "utf8"
  );

  assert.match(
    source,
    /addEventListener\("conversation_changed", scheduleRefresh\)/
  );
  assert.match(
    source,
    /removeEventListener\("conversation_changed", scheduleRefresh\)/
  );
});
