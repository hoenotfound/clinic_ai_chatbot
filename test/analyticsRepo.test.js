const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ANALYTICS_QUERY_CONCURRENCY,
  buildComparison,
  buildFunnel,
  createConcurrencyLimiter,
  metricDelta,
  percent,
} = require("../src/db/analyticsRepo");

test("analytics percentage helpers handle empty denominators", () => {
  assert.equal(percent(2, 10), 20);
  assert.equal(percent(1, 3), 33.3);
  assert.equal(percent(4, 0), 0);
});

test("comparison deltas use percentage change for count and value metrics", () => {
  assert.equal(metricDelta(120, 100), 20);
  assert.equal(metricDelta(80, 100), -20);
  assert.equal(metricDelta(0, 0), 0);
  assert.equal(metricDelta(10, 0), null);
});

test("conversion comparison is expressed as percentage-point movement", () => {
  const comparison = buildComparison(
    {
      newLeads: 120,
      appointments: 48,
      visits: 30,
      won: 24,
      conversionRate: 20,
      estimatedWonValue: 60000,
    },
    {
      newLeads: 100,
      appointments: 40,
      visits: 25,
      won: 15,
      conversionRate: 15,
      estimatedWonValue: 50000,
    }
  );

  assert.equal(comparison.deltas.newLeads, 20);
  assert.equal(comparison.deltas.won, 60);
  assert.equal(comparison.deltas.conversionRate, 5);
  assert.equal(comparison.deltas.estimatedWonValue, 20);
});

test("funnel reports stage rates and leads not yet progressed", () => {
  const funnel = buildFunnel({
    newLeads: 100,
    contacted: 80,
    appointments: 40,
    visits: 30,
    won: 12,
  });

  assert.deepEqual(funnel.map((stage) => stage.count), [100, 80, 40, 30, 12]);
  assert.equal(funnel[1].fromPreviousRate, 80);
  assert.equal(funnel[2].fromPreviousRate, 50);
  assert.equal(funnel[2].fromLeadRate, 40);
  assert.equal(funnel[2].dropOff, 40);
  assert.equal(funnel[4].dropOff, 18);
});

test("analytics concurrency limiter never exceeds the configured query cap", async () => {
  const run = createConcurrencyLimiter(ANALYTICS_QUERY_CONCURRENCY);
  let active = 0;
  let maxActive = 0;

  const perform = (delay) => run(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
  });

  const firstWave = Array.from(
    { length: ANALYTICS_QUERY_CONCURRENCY + 2 },
    (_, index) => perform(8 + index)
  );
  await new Promise((resolve) => setTimeout(resolve, 2));
  const lateArrivals = Array.from({ length: 7 }, (_, index) => perform(3 + (index % 3)));

  await Promise.all([...firstWave, ...lateArrivals]);
  assert.equal(maxActive, ANALYTICS_QUERY_CONCURRENCY);
});

test("analytics concurrency limiter releases capacity after a failed query", async () => {
  const run = createConcurrencyLimiter(1);

  await assert.rejects(
    run(async () => {
      throw new Error("query failed");
    }),
    /query failed/
  );

  assert.equal(await run(async () => "next query"), "next query");
});
