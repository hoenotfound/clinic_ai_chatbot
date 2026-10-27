const test = require("node:test");
const assert = require("node:assert/strict");
const { pendingSalesFollowUp, assertFollowUpOutcome, INACTIVITY_HOURS } =
  require("../src/utils/salesFollowUpEligibility");

const NOW = new Date("2026-10-27T08:00:00.000Z");
function candidate(patch = {}) {
  return {
    lead_id: 12, contact_id: 17, last_inbound_id: 20,
    is_closed: false, stage_type: "open", system_key: "contacted",
    temperature: "warm", channel: "whatsapp", whatsapp_number: "60123456789",
    whatsapp_opt_in_at: "2026-10-01T00:00:00Z",
    whatsapp_opt_out_at: null, whatsapp_marketing_opt_out_at: null,
    treatment_interest: "3D 小颜术", summary_treatment: "",
    appointment_status: "none", mode: "ai",
    last_inbound_at: "2026-10-25T08:00:00Z",
    next_follow_up_at: null,
    staff_replied_after_inbound: false, active_extended_follow_up: false,
    task_status: null, task_due_at: null, task_last_inbound_id: null,
    ...patch
  };
}

test("48 hours exactly is eligible, under 48 hours is excluded", () => {
  assert.equal(INACTIVITY_HOURS, 48);
  assert.equal(pendingSalesFollowUp(candidate(), NOW), true);
  assert.equal(pendingSalesFollowUp(candidate({ last_inbound_at: "2026-10-25T08:00:01Z" }), NOW), false);
});
test("hot and warm with verified interest are eligible", () => {
  assert.equal(pendingSalesFollowUp(candidate({ temperature: "hot" }), NOW), true);
  assert.equal(pendingSalesFollowUp(candidate({ temperature: "cold" }), NOW), false);
  assert.equal(pendingSalesFollowUp(candidate({ treatment_interest: "", summary_treatment: "" }), NOW), false);
  assert.equal(pendingSalesFollowUp(candidate({ treatment_interest: "", summary_treatment: "骨盆矫正" }), NOW), true);
});
test("appointment, visited and closed journeys are excluded", () => {
  for (const patch of [
    { appointment_status: "set" }, { appointment_status: "visited" },
    { system_key: "appointment_set" }, { system_key: "visited" },
    { stage_type: "won" }, { is_closed: true }
  ]) assert.equal(pendingSalesFollowUp(candidate(patch), NOW), false);
});
test("contact permission and opt-out are fail-closed", () => {
  for (const patch of [
    { whatsapp_opt_in_at: null }, { whatsapp_opt_out_at: "2026-10-26" },
    { whatsapp_marketing_opt_out_at: "2026-10-26" },
    { whatsapp_number: "bad" }, { channel: "instagram" }
  ]) assert.equal(pendingSalesFollowUp(candidate(patch), NOW), false);
});
test("AI follow-up, staff takeover, and recent staff response exclude candidates", () => {
  for (const patch of [
    { active_extended_follow_up: true }, { mode: "human" },
    { staff_replied_after_inbound: true },
    { next_follow_up_at: "2026-11-01T00:00:00Z" }
  ]) assert.equal(pendingSalesFollowUp(candidate(patch), NOW), false);
});
test("contacted leads wait until a NEW inbound conversation becomes stale", () => {
  assert.equal(pendingSalesFollowUp(candidate({ task_status: "contacted", task_last_inbound_id: 20 }), NOW), false);
  assert.equal(pendingSalesFollowUp(candidate({ task_status: "contacted", task_last_inbound_id: 19 }), NOW), true);
});
test("unable-to-contact outcomes do not loop without new customer activity", () => {
  assert.equal(pendingSalesFollowUp(candidate({ task_status: "unable", task_last_inbound_id: 20 }), NOW), false);
});
test("later task returns only on or after its due date", () => {
  assert.equal(pendingSalesFollowUp(candidate({ task_status: "later", task_due_at: "2026-10-28T00:00:00Z" }), NOW), false);
  assert.equal(pendingSalesFollowUp(candidate({ task_status: "later", task_due_at: "2026-10-27T08:00:00Z" }), NOW), true);
});
test("booked and explicitly not-interested tasks remain excluded", () => {
  for (const status of ["booked", "not_interested"]) {
    assert.equal(pendingSalesFollowUp(candidate({ task_status: status, task_last_inbound_id: 19 }), NOW), false);
  }
});
test("only supported outcomes can be recorded", () => {
  assert.throws(() => assertFollowUpOutcome("pending", null, NOW), /valid/);
  assert.equal(assertFollowUpOutcome("contacted", null, NOW), null);
});
test("later and booked require a future date", () => {
  for (const status of ["later", "booked"]) {
    assert.throws(() => assertFollowUpOutcome(status, null, NOW));
    assert.throws(() => assertFollowUpOutcome(status, "2026-10-27T07:59:59Z", NOW));
    assert.equal(assertFollowUpOutcome(status, "2026-10-28T08:00:00Z", NOW).toISOString(), "2026-10-28T08:00:00.000Z");
  }
});
