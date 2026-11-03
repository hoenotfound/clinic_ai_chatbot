"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createInboxRevisionGuard } = require("../src/utils/inboxRevisionGuard");
const { inboxPayloadEtag } = require("../src/utils/inboxConditionalResponse");

const etag = inboxPayloadEtag(JSON.stringify([
  { contact_id: 1, last_message: "safe" }, { contact_id: 2 },
]));
const wal = "0/214597D0";
const user = {
  id: 7, username: "staff", role: "staff",
  permissions: { view_assigned_leads: true },
};
const fields = { etag, wal, user, permittedIds: [1, 2] };

test("WAL fast path requires exact full-body ETag and current staff scope", () => {
  const guard = createInboxRevisionGuard(Buffer.alloc(32, 4));
  const proof = guard.makeProof(fields);
  assert.match(proof, /^v1\.[0-9a-f]{64}$/);
  assert.equal(guard.matchesProof(proof, fields), true);
  assert.equal(guard.matchesProof(proof, { ...fields, permittedIds: [2, 1] }),
    true, "SQL access row ordering is not meaningful");
  assert.equal(guard.matchesProof(proof, { ...fields, wal: "0/214597D1" }),
    false, "a single database WAL change forces a full query");
  assert.equal(guard.matchesProof(proof, { ...fields,
    etag: inboxPayloadEtag(JSON.stringify([])) }), false);
  assert.equal(guard.matchesProof(proof, { ...fields, permittedIds: [1] }),
    false, "revoked staff assignment cannot reuse the old list");
  assert.equal(guard.matchesProof(proof, { ...fields, permittedIds: [1, 2, 3] }),
    false, "newly assigned conversations require a fresh full list");
  assert.equal(guard.matchesProof(proof, { ...fields,
    user: { ...user, id: 9 } }), false);
  assert.equal(guard.matchesProof(proof, { ...fields,
    user: { ...user, permissions: { view_assigned_leads: false } } }), false);
});

test("different authenticated staff and deploys never share proof", () => {
  const first = createInboxRevisionGuard(Buffer.alloc(32, 1));
  const otherProcess = createInboxRevisionGuard(Buffer.alloc(32, 2));
  const proof = first.makeProof(fields);
  assert.equal(otherProcess.matchesProof(proof, fields), false);
  assert.equal(first.matchesProof(proof, { ...fields,
    user: { ...user, username: "other" } }), false);
  assert.equal(first.matchesProof(proof, { ...fields,
    permittedIds: null }), false);
  assert.equal(first.matchesProof("*", fields), false);
  assert.equal(first.matchesProof("v1.notasignature", fields), false);
  assert.equal(first.matchesProof(null, fields), false);
});

test("invalid identity, WAL or weak ETag disables the fast path safely", () => {
  const guard = createInboxRevisionGuard();
  for (const input of [
    { ...fields, user: { id: 0, username: "staff" } },
    { ...fields, user: { id: 7 } },
    { ...fields, wal: null },
    { ...fields, wal: "wrong" },
    { ...fields, etag: "W/" + etag },
    { ...fields, etag: "*" },
    { ...fields, permittedIds: undefined },
    { ...fields, permittedIds: [-1, 1] },
  ]) assert.equal(guard.makeProof(input), null);
});

test("route's fast validation is before list query and fails closed on unknown WAL", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/routes/conversations.js"), "utf8"
  );
  const start = source.indexOf('router.get("/", async (req, res) =>');
  const body = source.slice(start, source.indexOf('router.get("/directory-search"', start));
  const revision = body.indexOf('const wal = await readInboxWal()');
  const scope = body.indexOf('const currentAccess = await getAccessibleContactIds(req.user)');
  const proof = body.indexOf('inboxRevisionGuard.matchesProof(clientProof');
  const secondWal = body.indexOf('(await readInboxWal()) === wal');
  const shortCircuit = body.indexOf('res.status(304).end()');
  const query = body.indexOf('contactsRepo.listConversations({ accessibleContactIds: access })');
  const freshAccess = body.indexOf('const permittedIds = await getAccessibleContactIds(req.user)');
  assert.ok(start >= 0 && revision >= 0 && scope > revision && proof > scope &&
    secondWal > proof && shortCircuit > secondWal && query > shortCircuit &&
    freshAccess > query, "full list is skipped only after fresh scope and twice-confirmed WAL");
  assert.match(source, /catch\s*\{\s*return null;\s*\}/);
  assert.match(body, /if \(wal && clientEtag && clientProof\)/);
  assert.match(body, /if \(wal\) res\.locals\.inboxWalProof = \{ wal, permittedIds \}/);
  assert.doesNotMatch(body, /localStorage|sessionStorage|CREATE TABLE|INSERT INTO/);
});
