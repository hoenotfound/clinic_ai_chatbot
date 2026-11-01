"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function policy() {
  return import("../portal-frontend/src/utils/inboxRefreshPolicy.js");
}

test("single-flight Inbox refresh folds overlapping requests into one trailing snapshot", async () => {
  const { createSingleFlightInboxRefresh } = await policy();
  const refresh = createSingleFlightInboxRefresh();
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  let runs = 0;
  const first = refresh(async () => { runs += 1; await gate; });
  const second = refresh(async () => { runs += 1; });
  for (let i = 0; i < 25; i++) refresh(async () => { runs += 1; });
  assert.equal(second, first, "all callers await the same ongoing refresh");
  assert.equal(runs, 1, "the first request starts immediately");
  unblock();
  await first;
  assert.equal(runs, 2, "one final snapshot captures concurrent events");
});

test("Inbox refresh can request another read when a newer local summary supersedes it", async () => {
  const { createSingleFlightInboxRefresh } = await policy();
  const refresh = createSingleFlightInboxRefresh();
  let attempts = 0;
  await refresh(async (requestTrailing) => {
    attempts += 1;
    if (attempts === 1) requestTrailing();
  });
  assert.equal(attempts, 2);
});

test("failed Inbox refresh does not strand future refreshes", async () => {
  const { createSingleFlightInboxRefresh } = await policy();
  const refresh = createSingleFlightInboxRefresh();
  await assert.rejects(refresh(async () => { throw new Error("network failure"); }), /network failure/);
  let recovered = false;
  await refresh(async () => { recovered = true; });
  assert.equal(recovered, true);
});

test("pipeline updates target a single authorized summary only when identity is grounded", async () => {
  const { pipelineRefreshContactId } = await policy();
  const conversations = [
    { contact_id: 11, lead_id: 101, channel: "whatsapp" },
    { contact_id: 22, lead_id: 202, channel: "facebook" },
  ];
  assert.equal(pipelineRefreshContactId({ contactId: 11 }, conversations), 11);
  assert.equal(pipelineRefreshContactId({ leadId: 202 }, conversations), 22);
  assert.equal(pipelineRefreshContactId({ leadId: 303 }, conversations), null, "new lead requires full list");
  assert.equal(pipelineRefreshContactId({}, conversations), null, "redacted staff SSE requires full list");
  assert.equal(pipelineRefreshContactId({ leadId: null }, conversations), null, "global event requires full list");
  assert.equal(pipelineRefreshContactId({ contactId: "invalid" }, conversations), null);
  assert.equal(pipelineRefreshContactId({ leadId: 101 }, [{ contact_id: 11, lead_id: 101 }, { contact_id: 12, lead_id: 101 }]), null);
  assert.equal(pipelineRefreshContactId({ leadId: 202 }, null), null, "initial list must be loaded first");
});

test("Inbox wiring retains staff-safe full-list fallback and live summary refreshes", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../portal-frontend/src/pages/Inbox.jsx"), "utf8"
  );
  assert.match(source, /createSingleFlightInboxRefresh/);
  assert.match(source, /requestAnother\(\)/);
  assert.match(source, /pipelineRefreshContactId\(payload, conversationsRef\.current\)/);
  assert.match(source, /await refreshConversationSummary\(changedId\)/);
  assert.match(source, /catch\s*\{\s*await refreshConversations\(\)/);
  assert.match(source, /scheduleRefresh\(payload\.contactId \?\? null\)/);
  assert.match(source, /source\.onopen = \(\) => \{\s*scheduleRefresh\(\)/);
  assert.match(source, /refreshConversations\(\);\s*\}, \[\]\)/);
});
