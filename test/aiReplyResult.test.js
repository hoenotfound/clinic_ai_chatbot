const test = require("node:test");
const assert = require("node:assert/strict");

const { parseAiReplyResult } = require("../src/utils/aiReplyResult");

test("parses a structured booking-ready response and keeps booking metadata internal", () => {
  const result = parseAiReplyResult(JSON.stringify({
    reply: "can 👍 I'll get the PJ team to check Saturday afternoon for u",
    outcome: "booking_ready",
    treatment: "HIFU Non-Surgical Facelift",
    branch: "Petaling Jaya",
    appointmentPreference: "Saturday afternoon",
  }));

  assert.equal(result.bookingReady, true);
  assert.equal(result.flagged, false);
  assert.equal(result.text, "can 👍 I'll get the PJ team to check Saturday afternoon for u");
  assert.deepEqual(result.details, {
    treatment: "HIFU Non-Surgical Facelift",
    branch: "Petaling Jaya",
    appointmentPreference: "Saturday afternoon",
  });
});

test("structured booking_ready missing branch/time is rejected for retry/fallback", () => {
  assert.throws(
    () => parseAiReplyResult(JSON.stringify({
      reply: "which branch works for u?",
      outcome: "booking_ready",
      treatment: "HIFU Non-Surgical Facelift",
      branch: null,
      appointmentPreference: null,
    })),
    (err) => err.code === "INVALID_AI_RESPONSE"
  );
});

test("common unambiguous configured branch shorthand is canonicalized", () => {
  const result = parseAiReplyResult(JSON.stringify({
    reply: "I'll get the PJ team to check for u",
    outcome: "booking_ready",
    treatment: "HIFU Non-Surgical Facelift",
    branch: "PJ",
    appointmentPreference: "Saturday 3pm",
  }));

  assert.equal(result.bookingReady, true);
  assert.equal(result.details.branch, "Petaling Jaya");
});

test("non-configured Booking Ready branch is rejected for retry/fallback", () => {
  assert.throws(
    () => parseAiReplyResult(JSON.stringify({
      reply: "I'll get the team to check for u",
      outcome: "booking_ready",
      treatment: "HIFU Non-Surgical Facelift",
      branch: "Mont Kiara",
      appointmentPreference: "Saturday 3pm",
    })),
    (err) => err.code === "INVALID_AI_RESPONSE"
  );
});

test("malformed JSON-looking AI output fails closed instead of leaking raw control output", () => {
  assert.throws(
    () => parseAiReplyResult('{"reply":"hello","outcome":'),
    (err) => err.code === "INVALID_AI_RESPONSE"
  );
});

test("legacy markers remain supported during structured-output rollout", () => {
  const result = parseAiReplyResult("[[NEEDS_HUMAN]] our team will check this for u");
  assert.equal(result.flagged, true);
  assert.equal(result.structured, false);
  assert.equal(result.text, "our team will check this for u");
});
