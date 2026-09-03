const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractAiOutcomeSignals,
  extractHandoffSignal,
  NEEDS_HUMAN_MARKER,
  BOOKING_READY_MARKER,
} = require("../src/utils/attentionTriggers");
const { buildSystemPrompt } = require("../src/utils/systemPrompt");

test("BOOKING_READY is stripped before the patient sees the reply", () => {
  const result = extractAiOutcomeSignals(
    `${BOOKING_READY_MARKER} can, I'll get the Puchong team to confirm Saturday afternoon for u.`
  );

  assert.equal(result.bookingReady, true);
  assert.equal(result.flagged, false);
  assert.equal(
    result.text,
    "can, I'll get the Puchong team to confirm Saturday afternoon for u."
  );
});

test("NEEDS_HUMAN wins if a model accidentally emits both outcome markers", () => {
  const result = extractAiOutcomeSignals(
    `${BOOKING_READY_MARKER} ${NEEDS_HUMAN_MARKER} our team will assist u directly.`
  );

  assert.equal(result.flagged, true);
  assert.equal(result.bookingReady, false);
  assert.equal(result.text, "our team will assist u directly.");
});

test("existing handoff helper remains backward compatible", () => {
  assert.deepEqual(
    extractHandoffSignal(`${NEEDS_HUMAN_MARKER} team will follow up shortly.`),
    { text: "team will follow up shortly.", flagged: true }
  );
});

test("system prompt keeps booking-ready separate from confirmed appointments", () => {
  const prompt = buildSystemPrompt(false);

  assert.match(prompt, /\[\[BOOKING_READY\]\]/);
  assert.match(prompt, /specific clinic branch has been chosen/i);
  assert.match(prompt, /day\/date PLUS a time, time range, or daypart/i);
  assert.match(prompt, /NEVER say the appointment is booked, confirmed, secured, reserved, or successful/i);
  assert.match(prompt, /Appointment Set is a staff-confirmed CRM state/i);
});
