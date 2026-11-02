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
  assert.match(source, /createInboxLiveStartup\(\{/);
  assert.match(source, /source\.onopen = \(\) => startup\.onOpen\(\)/);
  assert.match(source, /startup\.stop\(\)/);
  assert.doesNotMatch(source, /refreshConversations\(\);\s*\}, \[\]\)/);
});

test("first SSE open loads the Inbox once; reconnects resync", async () => {
  const { createInboxLiveStartup } = await policy();
  const timers = new Map();
  let next = 0, loads = 0, reconnects = 0;
  const startup = createInboxLiveStartup({
    loadInitial: () => { loads++; },
    refreshOnReconnect: () => { reconnects++; },
    schedule: fn => { const id = ++next; timers.set(id, fn); return id; },
    cancel: id => { timers.delete(id); },
  });
  startup.onOpen();
  assert.equal(loads, 1, "first SSE open becomes the initial snapshot");
  assert.equal(reconnects, 0);
  assert.equal(timers.size, 0, "no later fallback read");
  startup.onOpen();
  assert.equal(loads, 1);
  assert.equal(reconnects, 1, "reconnect still reloads staff permissions and missing events");
  startup.stop();
});

test("unavailable SSE falls back promptly and late connection resynchronizes", async () => {
  const { createInboxLiveStartup } = await policy();
  const timers = new Map();
  let loadCount = 0, resyncCount = 0, scheduledDelay;
  const startup = createInboxLiveStartup({
    loadInitial: () => { loadCount++; },
    refreshOnReconnect: () => { resyncCount++; },
    schedule: (fn, delay) => { timers.set(1, fn); scheduledDelay = delay; return 1; },
    cancel: id => timers.delete(id),
  });
  assert.equal(scheduledDelay, 450);
  timers.get(1)();
  assert.equal(loadCount, 1, "Inbox remains available without the live connection");
  startup.onOpen();
  assert.equal(loadCount, 1);
  assert.equal(resyncCount, 1, "connection after fallback must close the event gap");
  startup.stop();
});

test("unmounted Inbox never launches a delayed fallback or reconnect", async () => {
  const { createInboxLiveStartup } = await policy();
  let fallback, loads = 0, reconnects = 0, cancelled = false;
  const startup = createInboxLiveStartup({
    loadInitial: () => { loads++; },
    refreshOnReconnect: () => { reconnects++; },
    schedule: fn => { fallback = fn; return 1; },
    cancel: () => { cancelled = true; },
  });
  startup.stop();
  fallback();
  startup.onOpen();
  assert.equal(cancelled, true);
  assert.equal(loads, 0);
  assert.equal(reconnects, 0);
});
