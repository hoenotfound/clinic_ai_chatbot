const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { Client } = require("pg");
if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
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
  assert.match(repo.ACTIVITY_SQL, /automated_follow_up_parent_message_id/);
  assert.match(repo.ACTIVITY_SQL, /parent\.contact_id = m\.contact_id/);
  assert.match(repo.ACTIVITY_SQL, /parent\.automated_follow_up_for_message_id IS NOT NULL/);
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
    if (sql.includes("SELECT c.id AS contact_id, c.channel")) return { rows: [] };
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

test("Postgres activity feed returns real persisted send, cancellation, pricing skip and review events", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL, ssl: false });
  const schema = "followup_activity_" + process.pid + "_" + Date.now();
  await client.connect();
  try {
    await client.query("CREATE SCHEMA " + schema);
    await client.query("SET search_path TO " + schema);
    await client.query(`
      CREATE TABLE contacts(id INTEGER PRIMARY KEY, channel TEXT NOT NULL);
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY, contact_id INTEGER NOT NULL, created_at TIMESTAMPTZ DEFAULT now(),
        delivery_status TEXT, delivery_error TEXT, is_automated_follow_up BOOLEAN NOT NULL DEFAULT false,
        whatsapp_message_id TEXT, whatsapp_accepted_at TIMESTAMPTZ, social_accepted_at TIMESTAMPTZ,
        media_mime_type TEXT, media_key TEXT, media_url TEXT,
        automated_follow_up_parent_message_id INTEGER,
        automated_follow_up_for_message_id INTEGER,
        pricing_reminder_anchor_id INTEGER, automated_follow_up_step INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE pricing_reminder_decisions (
        id INTEGER PRIMARY KEY, contact_id INTEGER NOT NULL, created_at TIMESTAMPTZ DEFAULT now(),
        reason TEXT NOT NULL
      );
      CREATE TABLE follow_up_ai_decisions (
        id INTEGER PRIMARY KEY, contact_id INTEGER NOT NULL,
        follow_up_step INTEGER, created_at TIMESTAMPTZ DEFAULT now(),
        action TEXT, reason TEXT
      );
      INSERT INTO contacts(id,channel) VALUES (1,'whatsapp'), (2,'facebook'), (3,'instagram');
      INSERT INTO messages(id,contact_id,delivery_status,is_automated_follow_up,automated_follow_up_for_message_id,automated_follow_up_step)
      VALUES (20,1,'sent',true,10,1),
             (21,1,'failed',true,10,2),
             (23,2,'cancelled',true,11,1),
             (99,1,'sent',false,10,1),
             (100,2,'sent',true,NULL,1),
             (24,2,'sent',true,13,3),
             (26,3,'sent',true,14,2);
      INSERT INTO messages(id,contact_id,delivery_status,is_automated_follow_up,pricing_reminder_anchor_id,automated_follow_up_step)
      VALUES (22,2,'pending',true,12,4);
      INSERT INTO pricing_reminder_decisions(id,contact_id,reason)
      VALUES (11,2,'missing_promotion');
      -- The social follow-up text was delivered but the separate testimonial
      -- video or image failed. Both events need independent activity rows.
      INSERT INTO messages(
        id, contact_id, delivery_status, is_automated_follow_up,
        automated_follow_up_parent_message_id, media_mime_type, media_key, media_url
      ) VALUES
        (25,2,'failed',true,24,'video/mp4','follow-up/testimonial.mp4',NULL),
        (27,3,'failed',true,26,'image/jpeg',NULL,'https://example.test/image.jpg'),
        -- A legacy, unlinked companion must not be attributed by proximity.
        (28,3,'failed',true,NULL,'video/mp4','follow-up/legacy.mp4',NULL);
      UPDATE messages SET whatsapp_message_id = 'wamid.provider123',
        whatsapp_accepted_at = now(), media_mime_type = 'video/mp4',
        media_key = 'follow-up/testimonial.mp4' WHERE id = 20;
      UPDATE messages SET media_mime_type = 'image/png', media_url = 'https://example.test/price.png',
        whatsapp_message_id = 'facebook:provider456', social_accepted_at = now() WHERE id = 22;
      INSERT INTO follow_up_ai_decisions(id,contact_id,follow_up_step,action,reason)
      VALUES (9,1,3,'human_review','manual_handoff');
    `);
    const execute = (sql, params) => client.query(sql, params);
    const result = await repo.listActivity({ channel: "all", type: "all" }, null, execute);
    assert.equal(result.total, 10);
    assert.deepEqual(result.summary, { sent: 3, pending: 1, failed: 3, skipped: 2, attention: 1 });
    assert.deepEqual(result.items.find((x) => x.event_id === "message:20") &&
      [result.items.find((x) => x.event_id === "message:20").media_type,
       result.items.find((x) => x.event_id === "message:20").provider_evidence],
      ["video", "accepted"]);
    assert.deepEqual(result.items.find((x) => x.event_id === "message:22") &&
      [result.items.find((x) => x.event_id === "message:22").media_type,
       result.items.find((x) => x.event_id === "message:22").provider_evidence],
      ["image", "accepted"]);
    const video = result.items.find((x) => x.event_id === "message:25");
    assert.deepEqual([video.channel, video.step, video.type, video.state, video.media_type,
      video.message_part, video.parent_message_id],
    ["facebook", 3, "sequence", "failed", "video", "media_companion", 24]);
    const image = result.items.find((x) => x.event_id === "message:27");
    assert.deepEqual([image.channel, image.step, image.type, image.state, image.media_type,
      image.message_part, image.parent_message_id],
    ["instagram", 2, "sequence", "failed", "image", "media_companion", 26]);
    assert.equal(result.items.find((x) => x.event_id === "message:24").state, "sent");
    assert.equal(result.items.find((x) => x.event_id === "message:26").state, "sent");
    assert.equal(result.items.some((x) => x.event_id === "message:28"), false);
    assert.equal(result.items.some((x) => x.event_id === "message:99"), false);
    assert.equal(result.items.some((x) => x.event_id === "message:100"), false);
    const failed = await repo.listActivity({ state: "failed" }, [1], execute);
    assert.equal(failed.total, 1);
    assert.equal(failed.items[0].event_id, "message:21");
    const facebook = await repo.listActivity({ channel: "facebook" }, [2], execute);
    assert.equal(facebook.total, 5);
    assert.equal(facebook.summary.skipped, 2);
    assert.equal(facebook.summary.failed, 1);
    const instagramFailed = await repo.listActivity({ channel: "instagram", state: "failed" }, [3], execute);
    assert.equal(instagramFailed.total, 1);
    assert.equal(instagramFailed.items[0].step, 2);
    assert.equal(instagramFailed.items[0].message_part, "media_companion");
    assert.equal(facebook.summary.pending, 1);
  } finally {
    await client.query("SET search_path TO public");
    await client.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    await client.end();
  }
});

test("FU3 gap diagnostics use expired latest inbound windows and do not claim proven quiet-hour skips", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL, ssl: false });
  const schema = "fu3_gaps_" + process.pid + "_" + Date.now();
  await client.connect();
  try {
    await client.query("CREATE SCHEMA " + schema);
    await client.query("SET search_path TO " + schema);
    await client.query(`
      CREATE TABLE contacts(id INTEGER PRIMARY KEY, channel TEXT NOT NULL);
      CREATE TABLE messages(
        id INTEGER PRIMARY KEY, contact_id INTEGER NOT NULL, role TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL, is_automated_follow_up BOOLEAN DEFAULT false,
        automated_follow_up_for_message_id INTEGER, automated_follow_up_step INTEGER,
        delivery_status TEXT
      );
      CREATE TABLE outbound_message_evidence(message_id INTEGER, origin TEXT);
      CREATE TABLE follow_up_ai_decisions(contact_id INTEGER, trigger_message_id INTEGER, action TEXT);
      INSERT INTO contacts VALUES(1,'whatsapp'),(2,'facebook'),(3,'instagram'),(4,'whatsapp'),(5,'whatsapp');
      INSERT INTO messages VALUES
        (101,1,'user',now()-interval '27 hours',false,NULL,NULL,NULL),
        (102,1,'assistant',now()-interval '26 hours 59 minutes',false,NULL,NULL,'sent'),
        (201,2,'user',now()-interval '27 hours',false,NULL,NULL,NULL),
        (202,2,'assistant',now()-interval '26 hours 59 minutes',false,NULL,NULL,'sent'),
        (203,2,'assistant',now()-interval '3 hours',true,202,3,'sent'),
        (301,3,'user',now()-interval '27 hours',false,NULL,NULL,NULL),
        (302,3,'assistant',now()-interval '26 hours 59 minutes',false,NULL,NULL,'sent'),
        (401,4,'user',now()-interval '3 hours',false,NULL,NULL,NULL),
        (402,4,'assistant',now()-interval '2 hours 59 minutes',false,NULL,NULL,'sent'),
        (501,5,'user',now()-interval '27 hours',false,NULL,NULL,NULL),
        (502,5,'assistant',now()-interval '26 hours 59 minutes',false,NULL,NULL,'sent');
      INSERT INTO follow_up_ai_decisions VALUES (3,302,'skip');
      INSERT INTO outbound_message_evidence VALUES (502,'system_fallback');
    `);
    const filters = repo.parseActivityFilters({ days: "7", channel: "all" });
    const config = { enabled: true, activatedAt: new Date(Date.now()-2*86400000).toISOString(),
      additionalSteps: [{ delayMinutes: 360 }, {
        timingMode: "before_window_expiry", beforeWindowExpiryMinutes: 120,
      }], quietHours: { enabled:true, start:"00:00", end:"07:00" } };
    const exec = (sql, params) => client.query(sql, params);
    const gaps = await repo.listSchedulingDiagnostics(filters, null, exec, config);
    assert.deepEqual(gaps.map(x => x.contact_id), [1]);
    assert.equal(gaps[0].channel, "whatsapp");
    assert.equal(typeof gaps[0].possible_quiet_overlap, "boolean");
    assert.deepEqual(await repo.listSchedulingDiagnostics(filters, [], exec, config), []);
    assert.deepEqual(await repo.listSchedulingDiagnostics(
      repo.parseActivityFilters({ type:"pricing" }), null, exec, config), []);
    assert.deepEqual(await repo.listSchedulingDiagnostics(filters, null, exec, { ...config, enabled:false }), []);
  } finally {
    await client.query("SET search_path TO public");
    await client.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    await client.end();
  }
});
