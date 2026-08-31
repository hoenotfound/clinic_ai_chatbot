const test = require("node:test");
const assert = require("node:assert/strict");
const realtimeEvents = require("../src/utils/realtimeEvents");

function fakeResponse(realtimeAccess) {
  const writes = [];
  return {
    writes,
    res: {
      req: realtimeAccess === undefined ? { user: {} } : { user: { realtimeAccess } },
      destroyed: false,
      writableEnded: false,
      write(message) {
        writes.push(message);
      },
    },
  };
}

test("restricted realtime clients never receive another contact identifier", () => {
  const restricted = fakeResponse({ contactIds: [10], leadIds: [20] });
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

test("restricted realtime clients receive identifiers they are allowed to see", () => {
  const restricted = fakeResponse({ contactIds: [10], leadIds: [20] });
  const cleanup = realtimeEvents.addClient(restricted.res);

  try {
    realtimeEvents.publish("pipeline_changed", { leadId: 20 });
    assert.equal(restricted.writes.length, 1);
    assert.match(restricted.writes[0], /\"leadId\":20/);
  } finally {
    cleanup();
  }
});

test("unrestricted realtime clients preserve the existing full payload behavior", () => {
  const unrestricted = fakeResponse(undefined);
  const cleanup = realtimeEvents.addClient(unrestricted.res);

  try {
    realtimeEvents.publish("conversation_changed", { contactId: 42 });
    assert.equal(unrestricted.writes.length, 1);
    assert.match(unrestricted.writes[0], /\"contactId\":42/);
  } finally {
    cleanup();
  }
});
