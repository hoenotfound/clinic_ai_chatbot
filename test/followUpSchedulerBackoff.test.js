"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  delayUntilNextFollowUp,
  OVERDUE_IDLE_RECHECK_MS,
  OVERDUE_ACTIVE_RECHECK_MS,
} = require("../src/services/followUpService");

const NOW = Date.parse("2026-10-30T02:00:00Z");
const at = offsetMs => new Date(NOW + offsetMs).toISOString();

test("past due non-actionable hints back off to one minute", () => {
  assert.equal(delayUntilNextFollowUp({
    enabled: true, candidateCount: 0, progressedCount: 0, recoveredCount: 0,
    nextDueAt: at(-600000), nextRecoveryAt: null,
  }, NOW), OVERDUE_IDLE_RECHECK_MS);

  assert.equal(delayUntilNextFollowUp({
    enabled: false, candidateCount: 0, progressedCount: 0, nextDueAt: at(-1000),
    nextRecoveryAt: at(-30000),
  }, NOW), OVERDUE_IDLE_RECHECK_MS);
});

test("blocked candidates do not cause a ten-second retry loop", () => {
  assert.equal(delayUntilNextFollowUp({
    enabled: true, candidateCount: 2, progressedCount: 0,
    nextDueAt: at(-1000),
  }, NOW), OVERDUE_IDLE_RECHECK_MS);
});

test("durable follow-up progress gets a short retry for remaining eligible work", () => {
  assert.equal(delayUntilNextFollowUp({
    enabled: true, candidateCount: 2, progressedCount: 1,
    nextDueAt: at(-1000),
  }, NOW), OVERDUE_ACTIVE_RECHECK_MS);
  assert.equal(delayUntilNextFollowUp({
    enabled: false, recoveredCount: 1, nextRecoveryAt: at(-1000),
  }, NOW), OVERDUE_ACTIVE_RECHECK_MS);
});

test("new upcoming deadline beats stale overdue recovery backoff", () => {
  assert.equal(delayUntilNextFollowUp({
    enabled: true, candidateCount: 0,
    nextDueAt: at(5000), nextRecoveryAt: at(-60000),
  }, NOW), 5000);
  assert.equal(delayUntilNextFollowUp({
    enabled: true, candidateCount: 0,
    nextDueAt: at(250), nextRecoveryAt: null,
  }, NOW), 1000);
});

test("stays asleep without work and safely handles malformed time", () => {
  assert.equal(delayUntilNextFollowUp({
    enabled: false, nextDueAt: at(-1000),
  }, NOW), null);
  assert.equal(delayUntilNextFollowUp({
    enabled: true, nextDueAt: "not-a-date",
  }, NOW), 60000);
});
