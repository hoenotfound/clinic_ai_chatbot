"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { inboxPayloadEtag, matchesInboxPayloadEtag } =
  require("../src/utils/inboxConditionalResponse");

test("full Inbox ETag changes with any authorized contact field or staff scope", () => {
  const allowed = JSON.stringify([{ contact_id: 9, is_unread: false }]);
  const changed = JSON.stringify([{ contact_id: 9, is_unread: true }]);
  const revoked = JSON.stringify([]);
  const tag = inboxPayloadEtag(allowed);
  assert.match(tag, /^"inbox-[a-f0-9]{64}"$/);
  assert.equal(tag, inboxPayloadEtag(allowed));
  assert.notEqual(tag, inboxPayloadEtag(changed));
  assert.notEqual(tag, inboxPayloadEtag(revoked));
  assert.equal(matchesInboxPayloadEtag(tag, tag), true);
  assert.equal(matchesInboxPayloadEtag(`"other", ${tag}`, tag), true);
  assert.equal(matchesInboxPayloadEtag(inboxPayloadEtag(changed), tag), false);
  assert.equal(matchesInboxPayloadEtag("*", tag), false);
  assert.equal(matchesInboxPayloadEtag(null, tag), false);
});

test("full Inbox route revalidates access before 304 and never persists sensitive cache", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/routes/conversations.js"), "utf8"
  );
  const route = source.indexOf('router.get("/", async (req, res) =>');
  const access = source.indexOf("getAccessibleContactIds(req.user)", route);
  const filtered = source.indexOf("const mapped = conversations.filter", access);
  const sent = source.indexOf('sendMeasuredInboxJson(res, mapped, startedAt, "list")', filtered);
  const conditional = source.indexOf('if (matchesInboxPayloadEtag(res.req?.get("If-None-Match"), etag))');
  assert.ok(route >= 0 && access > route && filtered > access && sent > filtered);
  assert.ok(conditional > 0);
  assert.match(source, /res\.set\("Cache-Control", "private, no-store"\)/);
  assert.match(source, /res\.status\(304\)\.end\(\)/);
  assert.match(source, /if \(kind === "list"\)/,
    "only the full Inbox endpoint gets a patient-data validator");
});

test("volatile Inbox API only reuses snapshot after explicit server 304, resets on logout", async () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../portal-frontend/src/api.js"), "utf8"
  );
  const { api } = await import("data:text/javascript;base64," +
    Buffer.from(source).toString("base64"));
  const oldFetch = globalThis.fetch;
  const calls = [];
  const responses = [
    new Response(JSON.stringify([{ contact_id: 1, last_message: "one" }]), {
      status: 200, headers: { etag: '"inbox-test-a"',
        "x-inbox-revision-proof": "v1.testproof-a" },
    }),
    new Response(null, { status: 304, headers: { etag: '"inbox-test-a"',
      "x-inbox-revision-proof": "v1.testproof-a2" } }),
    new Response(JSON.stringify([{ contact_id: 1, last_message: "two" }]), {
      status: 200, headers: { etag: '"inbox-test-b"',
        "x-inbox-revision-proof": "v1.testproof-b" },
    }),
    new Response("{}", { status: 200 }), // logout
    new Response(JSON.stringify([{ contact_id: 2 }]), {
      status: 200, headers: { etag: '"inbox-test-c"',
        "x-inbox-revision-proof": "v1.testproof-c" },
    }),
    new Response("{}", { status: 401 }), // auth expired
    new Response(JSON.stringify([{ contact_id: 3 }]), {
      status: 200, headers: { etag: '"inbox-test-d"' },
    }),
  ];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    assert.ok(next, "unexpected extra network fetch");
    return next;
  };
  try {
    const first = await api.listConversations("startup");
    assert.equal(first[0].last_message, "one");
    assert.equal(calls[0].options.headers["If-None-Match"], undefined);
    assert.equal(calls[0].options.cache, "no-store");

    const unchanged = await api.listConversations("reconnect");
    assert.strictEqual(unchanged, first, "304 reuses the exact per-tab snapshot");
    assert.equal(calls[1].options.headers["If-None-Match"], '"inbox-test-a"');
    assert.equal(calls[1].options.headers["X-Inbox-Revision-Proof"], "v1.testproof-a");
    const latest = await api.listConversations("multi_contact_event");
    assert.equal(latest[0].last_message, "two",
      "new server content must replace cached contact state");
    assert.equal(calls[2].options.headers["If-None-Match"], '"inbox-test-a"');
    assert.equal(calls[2].options.headers["X-Inbox-Revision-Proof"], "v1.testproof-a2",
      "full-query 304 can upgrade revision proof without re-downloading the list");

    await api.logout();
    assert.equal(calls[3].url, "/api/auth/logout");
    const next = await api.listConversations("startup");
    assert.deepEqual(next, [{ contact_id: 2 }]);
    assert.equal(calls[4].options.headers["X-Inbox-Revision-Proof"], undefined);
    assert.equal(calls[4].options.headers["If-None-Match"], undefined,
      "logout prevents old patient's cached data from leaking across sessions");

    await assert.rejects(api.listConversations("reconnect"), err => err.status === 401);
    assert.equal(calls[5].options.headers["If-None-Match"], '"inbox-test-c"');
    assert.equal(calls[5].options.headers["X-Inbox-Revision-Proof"], "v1.testproof-c");
    await api.listConversations("startup");
    assert.equal(calls[6].options.headers["X-Inbox-Revision-Proof"], undefined);
    assert.equal(calls[6].options.headers["If-None-Match"], undefined,
      "401 clears cached data and validator");
  } finally {
    globalThis.fetch = oldFetch;
  }
});
