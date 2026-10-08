const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getAiUsageSummary,
  recordAiUsage,
} = require("../src/db/aiUsageRepo");

test("recordAiUsage stores only bounded usage metadata fields", async () => {
  const calls = [];
  const database = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };

  await recordAiUsage({
    provider: "gemini",
    model: "gemini-2.5-flash",
    purpose: "customer_reply",
    status: "success",
    promptTokens: 1234,
    outputTokens: 87,
    thinkingTokens: 0,
    cachedTokens: 12,
    cacheMetadataPresent: true,
    promptPrefixHash: "0123456789abcdef",
    responseDisposition: "accepted",
    totalTokens: 1321,
    latencyMs: 640,
  }, database);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO ai_usage_events/);
  assert.deepEqual(calls[0].params, [
    "gemini",
    "gemini-2.5-flash",
    "customer_reply",
    "success",
    null,
    1234,
    87,
    0,
    12,
    1321,
    640,
    true,
    "0123456789abcdef",
    "accepted",
  ]);
});

test("getAiUsageSummary returns totals plus model, purpose and failure-cause breakdowns", async () => {
  const responses = [
    { rows: [{
      requests: 10,
      successful_requests: 7,
      failed_requests: 3,
      prompt_tokens: "4000",
      output_tokens: "500",
      thinking_tokens: "0",
      cached_tokens: "200",
      cache_metadata_present_requests: 4,
      cache_metadata_missing_requests: 2,
      cache_metadata_unknown_requests: 1,
      cache_hit_requests: 3,
      distinct_prompt_prefixes: 2,
      accepted_responses: 5,
      rejected_responses: 1,
      discarded_responses: 1,
      aborted_requests: 2,
      total_tokens: "4500",
      average_latency_ms: "720",
    }] },
    { rows: [{
      provider: "gemini",
      model: "gemini-2.5-flash",
      requests: 6,
      successful_requests: 3,
      failed_requests: 3,
      total_tokens: "2500",
    }] },
    { rows: [{
      purpose: "customer_reply",
      requests: 8,
      successful_requests: 5,
      failed_requests: 3,
      total_tokens: "3900",
    }] },
    { rows: [
      { failure_kind: "model_unavailable", requests: 2 },
      { failure_kind: "rate_limit", requests: 1 },
    ] },
  ];
  let index = 0;
  const database = {
    async query() {
      return responses[index++];
    },
  };

  const summary = await getAiUsageSummary(database, { hours: 24 });

  assert.equal(summary.requests, 10);
  assert.equal(summary.totalTokens, 4500);
  assert.equal(summary.cacheMetadataPresentRequests, 4);
  assert.equal(summary.cacheMetadataMissingRequests, 2);
  assert.equal(summary.cacheMetadataUnknownRequests, 1);
  assert.equal(summary.cacheHitRequests, 3);
  assert.equal(summary.distinctPromptPrefixes, 2);
  assert.equal(summary.acceptedResponses, 5);
  assert.equal(summary.rejectedResponses, 1);
  assert.equal(summary.discardedResponses, 1);
  assert.equal(summary.abortedRequests, 2);
  assert.equal(summary.averageLatencyMs, 720);
  assert.deepEqual(summary.byModel[0], {
    provider: "gemini",
    model: "gemini-2.5-flash",
    requests: 6,
    successfulRequests: 3,
    failedRequests: 3,
    totalTokens: 2500,
  });
  assert.deepEqual(summary.byPurpose[0], {
    purpose: "customer_reply",
    requests: 8,
    successfulRequests: 5,
    failedRequests: 3,
    totalTokens: 3900,
  });
  assert.deepEqual(summary.failuresByKind, [
    { failureKind: "model_unavailable", requests: 2 },
    { failureKind: "rate_limit", requests: 1 },
  ]);
});

test("legacy events remain cache-metadata unknown, never silently false",async()=>{
  const captured=[];
  await recordAiUsage({provider:"gemini",model:"m",purpose:"customer_reply",status:"success",cachedTokens:0,promptPrefixHash:"raw patient prompt"},{
    async query(sql,params){captured.push(params);return {rows:[]};}
  });
  assert.equal(captured[0][11],null);
  assert.equal(captured[0][12],null);
  assert.equal(captured[0][13],null);
});
