const test = require("node:test");
const assert = require("node:assert/strict");
const realtimeEvents = require("../src/utils/realtimeEvents");

function fakeResponse(realtimeAccess, userId = null) {
  const writes = [];
  const user = { id: userId };
  if (realtimeAccess !== undefined) user.realtimeAccess = realtimeAccess;

  return {
    writes,
    res: {
      req: { user },
      destroyed: false,
      writableEnded: false,
      write(message) {
        writes.push(message);
      },
      end() {
        this.writableEnded = true;
      },
    },
  };
}

test("restricted realtime clients never receive another contact identifier", () => {
  const restricted = fakeResponse({ contactIds: [10], leadIds: [20] }, 7);
  const cleanup = realtimeEvents.addClient(restricted.res);

  try {
    realtimeEvents.publish("conversation_changed", {
      contactId: 999,
      reason: "contact_state",
    });

    assert.equal(restricted.writes.length, 1);
    assert.match(restricted.writes[0], /event: conversation_changed/);
    assert.match(restricted.writes[0], /data: \{\}/);
    assert.doesNotMatch(restricted.writes[0], /999/);
  } finally {
    cleanup();
  }
});

test("ordinary Pipeline changes stay Pipeline-only for restricted realtime clients", () => {
  const restricted = fakeResponse({ contactIds: [10], leadIds: [20] }, 7);
  const cleanup = realtimeEvents.addClient(restricted.res);

  try {
    realtimeEvents.publish("pipeline_changed", { leadId: 20 });

    assert.equal(restricted.writes.length, 1);
    assert.match(restricted.writes[0], /event: pipeline_changed/);
    assert.match(restricted.writes[0], /data: \{\}/);
    assert.doesNotMatch(restricted.writes[0], /conversation_changed/);
    assert.doesNotMatch(restricted.writes[0], /20/);
  } finally {
    cleanup();
  }
});

test("unrestricted realtime clients preserve full payloads without synthetic Inbox events", () => {
  const unrestricted = fakeResponse(undefined, 8);
  const cleanup = realtimeEvents.addClient(unrestricted.res);

  try {
    realtimeEvents.publish("conversation_changed", { contactId: 42 });
    assert.equal(unrestricted.writes.length, 1);
    assert.match(unrestricted.writes[0], /\"contactId\":42/);

    unrestricted.writes.length = 0;
    realtimeEvents.publish("pipeline_changed", { leadId: 24 });
    assert.equal(unrestricted.writes.length, 1);
    assert.match(unrestricted.writes[0], /event: pipeline_changed/);
    assert.match(unrestricted.writes[0], /\"leadId\":24/);
    assert.doesNotMatch(unrestricted.writes[0], /conversation_changed/);
  } finally {
    cleanup();
  }
});

test("disconnectUser closes only realtime connections for the changed account", () => {
  const first = fakeResponse({ contactIds: [10], leadIds: [20] }, 7);
  const second = fakeResponse({ contactIds: [11], leadIds: [21] }, 8);
  const cleanupFirst = realtimeEvents.addClient(first.res);
  const cleanupSecond = realtimeEvents.addClient(second.res);

  try {
    assert.equal(realtimeEvents.disconnectUser(7), 1);
    assert.equal(first.res.writableEnded, true);
    assert.equal(second.res.writableEnded, false);

    realtimeEvents.publish("conversation_changed", { contactId: 11 });
    assert.equal(first.writes.length, 0);
    assert.equal(second.writes.length, 1);
  } finally {
    cleanupFirst();
    cleanupSecond();
  }
});
