"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { recordWorkerRun, takeWorkerActivity } = require("../src/utils/workerActivityMetrics");

test("aggregates only static operational worker labels and resets per sample", () => {
  takeWorkerActivity();
  recordWorkerRun("Automated follow-up worker", 10);
  recordWorkerRun("Automated follow-up worker", 20, true);
  recordWorkerRun("user:+60123456789", 33);
  assert.deepEqual(takeWorkerActivity(), [
    { label: "Automated follow-up worker", runs: 2, failures: 1, totalMs: 30, maxMs: 20 },
    { label: "unnamed worker", runs: 1, failures: 0, totalMs: 33, maxMs: 33 },
  ]);
  assert.deepEqual(takeWorkerActivity(), []);
});

test("worker aggregation never grows beyond 40 distinct labels", () => {
  for (let i = 0; i < 100; i++) recordWorkerRun("worker " + i, 1);
  const result = takeWorkerActivity();
  assert.equal(result.length, 40);
  assert.ok(result.every(row => row.runs === 1));
});
