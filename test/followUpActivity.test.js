const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { pool } = require("../src/db/db");
const repo = require("../src/db/followUpActivityRepo");
const route = require("../src/routes/followUpActivity");

test("activity filters are restricted and pagination is bounded", () => {
  assert.deepEqual(repo.parseActivityFilters({ days: "30", channel: "instagram", type: "pricing", state: "attention", page: "2" }),
    { days: 30, channel: "instagram", type: "pricing", state: "attention", page: 2 });
  for (const query of [{ days: "365" }, { channel: "invalid" }, { type: "junk" },
    { state: "delivered" }, { page: "21" }, { page: "-1" }, { page: "1.2" }]) {
    assert.equal(repo.parseActivityFilters(query), null);
  }
  assert.match(repo.ACTIVITY_SQL, /pricing_reminder_decisions/);
  assert.match(repo.ACTIVITY_SQL, /follow_up_ai_decisions/);
  assert.match(repo.ACTIVITY_SQL, /pricing_reminder_anchor_id IS NOT NULL/);
  assert.match(repo.ACTIVITY_SQL, /ANY\(\$7::integer\[\]\)/);
  assert.match(repo.ACTIVITY_SQL, /LIMIT \$5::integer OFFSET \$6::integer/);
});

test("activity listing applies channel, status and contact access to the query", async () => {
  let seen = null;
  const out = await repo.listActivity(
    { days: "7", channel: "facebook", type: "sequence", state: "failed", page: "2" },
    [11, 12],
    async (sql, params) => {
      seen = { sql, params };
      return { rows: [{
        total: 26, summary: { sent: 12, pending: 1, failed: 26, skipped: 4, attention: 3 },
        items: [{ event_id: "message:31", contact_id: 11, channel: "facebook",
          state: "failed", type: "sequence", step: 2, detail: "Provider error" }],
      }] };
    }
  );
  assert.deepEqual(seen.params, [7, "facebook", "sequence", "failed", repo.PAGE_SIZE, 25, [11, 12]]);
  assert.equal(out.items[0].event_id, "message:31");
  assert.equal(out.hasMore, false);
  assert.equal(out.summary.sent, 12); // totals are not restricted to selected state
  assert.equal(out.total, 26);
});

test("no-contact-access returns no records without querying database", async () => {
  let called = false;
  const out = await repo.listActivity({}, [], async () => { called = true; });
  assert.equal(called, false);
  assert.equal(out.total, 0);
  assert.deepEqual(out.items, []);
});

test("read-only activity endpoint requires manage_tools and respects contact permissions", async () => {
  const originalQuery = pool.query;
  const calls = [];
  const app = express();
  let user = { username: "staff", role: "sales", permissions: { manage_tools: false } };
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use("/api/follow-up-activity", route);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("WITH current_lead")) return { rows: [{ contact_id: 24 }] };
    return { rows: [{ total: 1, summary: { sent: 1 },
      items: [{ event_id: "message:100", contact_id: 24, channel: "whatsapp", state: "sent" }] }] };
  };
  try {
    let res = await fetch(base + "/api/follow-up-activity");
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
    user = { username: "staff", role: "sales", permissions: {
      manage_tools: true, view_all_leads: false, view_assigned_leads: true,
    } };
    res = await fetch(base + "/api/follow-up-activity?channel=whatsapp");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).items[0].contact_id, 24);
    assert.deepEqual(calls.at(-1).params.at(-1), [24]);
    res = await fetch(base + "/api/follow-up-activity?days=180");
    assert.equal(res.status, 400);
    user = { username: "staff", role: "sales", permissions: {
      manage_tools: true, view_all_leads: false, view_assigned_leads: false,
    } };
    const before = calls.length;
    res = await fetch(base + "/api/follow-up-activity");
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).items, []);
    assert.equal(calls.length, before);
  } finally {
    pool.query = originalQuery;
    await new Promise((resolve) => server.close(resolve));
  }
});
