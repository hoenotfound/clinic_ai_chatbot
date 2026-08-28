const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const realtimeEvents = require("../src/utils/realtimeEvents");
const pipelineRepo = require("../src/db/pipelineRepo");

test("creates one open lead with an atomic partial-conflict claim", async (t) => {
  const originalConnect = pool.connect;
  const originalPublish = realtimeEvents.publish;
  t.after(() => {
    pool.connect = originalConnect;
    realtimeEvents.publish = originalPublish;
  });

  const queries = [];
  let released = false;
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT l\.\*, s\.name AS stage_name/.test(sql)) return { rows: [] };
      if (/SELECT id, name FROM pipeline_stages/.test(sql)) {
        assert.match(sql, /CASE WHEN system_key = 'new' THEN 0 ELSE 1 END/);
        return { rows: [{ id: 2, name: "New Lead" }] };
      }
      if (/INSERT INTO leads/.test(sql)) {
        assert.match(sql, /ON CONFLICT \(contact_id\) WHERE is_closed = false DO NOTHING/);
        assert.match(sql, /started_message_id/);
        assert.match(sql, /COALESCE\(\$3, \(SELECT MAX\(m\.id\)/);
        assert.deepEqual(params, [7, 2, 33, "Automation"]);
        return { rows: [{ id: 41, contact_id: 7, stage_id: 2 }] };
      }
      return { rows: [] };
    },
    release: () => {
      released = true;
    },
  };
  pool.connect = async () => client;
  const published = [];
  realtimeEvents.publish = (event, payload) => published.push({ event, payload });

  const result = await pipelineRepo.ensureLeadForContact(7, "Automation", 33);

  assert.equal(result.created, true);
  assert.equal(result.lead.id, 41);
  assert.equal(queries[0].sql, "BEGIN");
  assert.equal(queries.at(-1).sql, "COMMIT");
  assert.equal(released, true);
  assert.deepEqual(published, [{ event: "pipeline_changed", payload: { leadId: 41 } }]);
});

test("the first new message initializes a staff-created journey boundary", async (t) => {
  const originalConnect = pool.connect;
  const originalPublish = realtimeEvents.publish;
  t.after(() => {
    pool.connect = originalConnect;
    realtimeEvents.publish = originalPublish;
  });

  const queries = [];
  pool.connect = async () => ({
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT l\.\*, s\.name AS stage_name/.test(sql)) {
        return { rows: [{ id: 42, contact_id: 7, started_message_id: null }] };
      }
      if (/SET started_message_id = COALESCE/.test(sql)) {
        return { rows: [{ id: 42, contact_id: 7, started_message_id: 77 }] };
      }
      return { rows: [] };
    },
    release: () => {},
  });
  const published = [];
  realtimeEvents.publish = (event, payload) => published.push({ event, payload });

  const result = await pipelineRepo.ensureLeadForContact(7, "Automation", 77);

  assert.equal(result.created, false);
  assert.equal(result.boundaryInitialized, true);
  assert.equal(result.lead.started_message_id, 77);
  const update = queries.find(({ sql }) => /SET started_message_id = COALESCE/.test(sql));
  assert.match(update.sql, /SELECT MIN\(m\.id\) FROM messages m/);
  assert.match(update.sql, /m\.created_at >= l\.created_at/);
  assert.deepEqual(update.params, [42, 77]);
  assert.deepEqual(published, [{ event: "pipeline_changed", payload: { leadId: 42 } }]);
});

test("a concurrent lead claim still keeps the earliest inbound message", async (t) => {
  const originalConnect = pool.connect;
  const originalPublish = realtimeEvents.publish;
  t.after(() => {
    pool.connect = originalConnect;
    realtimeEvents.publish = originalPublish;
  });

  let activeReads = 0;
  let boundaryParams = null;
  pool.connect = async () => ({
    query: async (sql, params) => {
      if (/SELECT l\.\*, s\.name AS stage_name/.test(sql)) {
        activeReads += 1;
        return activeReads === 1
          ? { rows: [] }
          : { rows: [{ id: 43, contact_id: 7, started_message_id: 102 }] };
      }
      if (/SELECT id, name FROM pipeline_stages/.test(sql)) {
        return { rows: [{ id: 2, name: "New Lead" }] };
      }
      if (/INSERT INTO leads/.test(sql)) return { rows: [] };
      if (/SET started_message_id = COALESCE/.test(sql)) {
        boundaryParams = params;
        return { rows: [{ id: 43, contact_id: 7, started_message_id: 101 }] };
      }
      return { rows: [] };
    },
    release: () => {},
  });
  const published = [];
  realtimeEvents.publish = (event, payload) => published.push({ event, payload });

  const result = await pipelineRepo.ensureLeadForContact(7, "Automation", 101);

  assert.equal(result.created, false);
  assert.equal(result.boundaryInitialized, true);
  assert.equal(result.lead.started_message_id, 101);
  assert.deepEqual(boundaryParams, [43, 101]);
  assert.deepEqual(published, [{ event: "pipeline_changed", payload: { leadId: 43 } }]);
});

test("backfill ignores contacts that already have any recorded journey", async (t) => {
  const originalConnect = pool.connect;
  const originalPublish = realtimeEvents.publish;
  t.after(() => {
    pool.connect = originalConnect;
    realtimeEvents.publish = originalPublish;
  });

  let backfillSql = "";
  pool.connect = async () => ({
    query: async (sql) => {
      if (/INSERT INTO leads/.test(sql)) {
        backfillSql = sql;
        return { rows: [] };
      }
      return { rows: [] };
    },
    release: () => {},
  });
  realtimeEvents.publish = () => {
    throw new Error("An empty backfill should not publish an event");
  };

  const count = await pipelineRepo.backfillLeadsForExistingContacts();
  assert.equal(count, 0);
  assert.match(
    backfillSql,
    /NOT EXISTS \(SELECT 1 FROM leads existing WHERE existing\.contact_id = c\.id\)/
  );
  assert.match(backfillSql, /CASE WHEN system_key = 'new' THEN 0 ELSE 1 END/);
  assert.match(backfillSql, /SELECT MIN\(m\.id\) FROM messages m WHERE m\.contact_id = c\.id/);
});

test("a successful first outbound message moves a new lead to contacted", async (t) => {
  const originalConnect = pool.connect;
  const originalPublish = realtimeEvents.publish;
  t.after(() => {
    pool.connect = originalConnect;
    realtimeEvents.publish = originalPublish;
  });

  const queries = [];
  pool.connect = async () => ({
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT l\.id, l\.stage_id/.test(sql)) {
        assert.match(sql, /FOR UPDATE OF l/);
        return {
          rows: [{ id: 51, stage_id: 1, stage_name: "New Lead", system_key: "new" }],
        };
      }
      if (/WHERE system_key = 'contacted'/.test(sql)) {
        return { rows: [{ id: 2, name: "Contacted" }] };
      }
      return { rows: [] };
    },
    release: () => {},
  });
  const published = [];
  realtimeEvents.publish = (event, payload) => published.push({ event, payload });

  const moved = await pipelineRepo.markContactedForContact(7, "staff@example.com");

  assert.equal(moved, true);
  assert.ok(queries.some(({ sql, params }) =>
    /UPDATE leads SET stage_id/.test(sql) && params[0] === 2 && params[1] === 51
  ));
  assert.ok(queries.some(({ sql, params }) =>
    /INSERT INTO lead_stage_history/.test(sql) && params[3] === "staff@example.com"
  ));
  assert.deepEqual(published, [{ event: "pipeline_changed", payload: { leadId: 51 } }]);
});

test("outbound messages do not pull progressed leads back to contacted", async (t) => {
  const originalConnect = pool.connect;
  const originalPublish = realtimeEvents.publish;
  t.after(() => {
    pool.connect = originalConnect;
    realtimeEvents.publish = originalPublish;
  });

  const queries = [];
  realtimeEvents.publish = () => {
    throw new Error("An unchanged lead should not publish an event");
  };
  pool.connect = async () => ({
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT l\.id, l\.stage_id/.test(sql)) {
        return {
          rows: [{ id: 52, stage_id: 4, stage_name: "Appointment Set", system_key: "appointment_set" }],
        };
      }
      return { rows: [] };
    },
    release: () => {},
  });

  const moved = await pipelineRepo.markContactedForContact(8, "Bot");

  assert.equal(moved, false);
  assert.equal(queries.some(({ sql }) => /UPDATE leads SET stage_id/.test(sql)), false);
});

test("manual lead creation resolves a concurrent open-lead claim", async (t) => {
  const originalConnect = pool.connect;
  const originalPublish = realtimeEvents.publish;
  t.after(() => {
    pool.connect = originalConnect;
    realtimeEvents.publish = originalPublish;
  });

  let activeLeadQueries = 0;
  let insertSql = "";
  let entryStageSql = "";
  realtimeEvents.publish = () => {
    throw new Error("A lead created by another request should not publish twice");
  };
  pool.connect = async () => ({
    query: async (sql) => {
      if (/SELECT l\.\*, s\.name AS stage_name/.test(sql)) {
        activeLeadQueries += 1;
        return activeLeadQueries === 1
          ? { rows: [] }
          : { rows: [{ id: 61, contact_id: 17, stage_id: 1 }] };
      }
      if (/SELECT id, name, stage_type, system_key FROM pipeline_stages/.test(sql)) {
        entryStageSql = sql;
        return { rows: [{ id: 1, name: "New Lead", stage_type: "open", system_key: "new" }] };
      }
      if (/INSERT INTO leads/.test(sql)) {
        insertSql = sql;
        return { rows: [] };
      }
      return { rows: [] };
    },
    release: () => {},
  });

  const result = await pipelineRepo.createLead({ contactId: 17 }, "staff@example.com");

  assert.equal(result.created, false);
  assert.equal(result.lead.id, 61);
  assert.match(entryStageSql, /CASE WHEN system_key = 'new' THEN 0 ELSE 1 END/);
  assert.match(insertSql, /ON CONFLICT \(contact_id\) WHERE is_closed = false DO NOTHING/);
  assert.match(insertSql, /started_message_id/);
  assert.match(insertSql, /temperature_locked, started_message_id/);
  assert.match(insertSql, /\$1, \$2, \$3, \$4, \$5,\s+NULL,/);
  assert.doesNotMatch(insertSql, /SELECT MAX\(m\.id\)/);
});

test("saving details in the same closed stage preserves the original close time", async (t) => {
  const originalConnect = pool.connect;
  const originalPublish = realtimeEvents.publish;
  t.after(() => {
    pool.connect = originalConnect;
    realtimeEvents.publish = originalPublish;
  });

  let updateSql = "";
  const current = {
    id: 71,
    stage_id: 6,
    stage_name: "Closed / Lost",
    stage_type: "lost",
    system_key: "lost",
    notes: "Old note",
    lost_reason: "No budget",
    is_closed: true,
    closed_at: "2026-08-01T00:00:00.000Z",
  };
  realtimeEvents.publish = () => {};
  pool.connect = async () => ({
    query: async (sql) => {
      if (/SELECT l\.\*, s\.name AS stage_name/.test(sql) && /FOR UPDATE/.test(sql)) {
        return { rows: [current] };
      }
      if (/SELECT id, name, sort_order, color, stage_type, system_key/.test(sql)) {
        return {
          rows: [{ id: 6, name: "Closed / Lost", stage_type: "lost", system_key: "lost" }],
        };
      }
      if (/UPDATE leads SET/.test(sql)) {
        updateSql = sql;
        return { rows: [{ ...current, notes: "Updated note" }] };
      }
      return { rows: [] };
    },
    release: () => {},
  });

  await pipelineRepo.updateLead(71, { stageId: 6, notes: "Updated note" }, "staff@example.com");

  assert.doesNotMatch(updateSql, /closed_at|is_closed/);
});

test("no-reply classification excludes failed and unconfirmed messages", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let listSql = "";
  pool.query = async (sql) => {
    listSql = sql;
    return { rows: [] };
  };

  await pipelineRepo.listLeads();

  assert.match(listSql, /latest\.delivery_status IN \('pending', 'sent', 'delivered', 'read'\)/);
  assert.doesNotMatch(listSql, /latest\.delivery_status IN \([^)]*'failed'/);
  assert.doesNotMatch(listSql, /latest\.delivery_status IN \([^)]*'unknown'/);
  assert.match(listSql, /m\.id >= l\.started_message_id/);
  assert.match(listSql, /m\.created_at >= l\.created_at/);
  assert.match(listSql, /m\.id < next_journey\.started_message_id/);
  assert.match(listSql, /m\.created_at < next_journey\.journey_created_at/);
});

test("rule-based temperature update is atomic and only claims a still-Warm lead", async (t) => {
  const originalConnect = pool.connect;
  const originalPublish = realtimeEvents.publish;
  t.after(() => {
    pool.connect = originalConnect;
    realtimeEvents.publish = originalPublish;
  });

  const queries = [];
  pool.connect = async () => ({
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/UPDATE leads/.test(sql)) {
        return { rows: [{ id: 81, temperature: "hot" }] };
      }
      return { rows: [] };
    },
    release: () => {},
  });
  const published = [];
  realtimeEvents.publish = (event, payload) => published.push({ event, payload });

  const updated = await pipelineRepo.applyRuleBasedTemperature(81, {
    temperature: "hot",
    matchedRule: "booking_intent",
    reason: "The customer accepted an appointment tomorrow.",
    evidence: "Please book me for tomorrow.",
  });

  assert.equal(updated.temperature, "hot");
  const update = queries.find(({ sql }) => /UPDATE leads/.test(sql));
  assert.match(update.sql, /is_closed = false AND temperature = 'warm'/);
  assert.match(update.sql, /temperature_locked = false/);
  assert.match(update.sql, /temperature_source = 'rule'/);
  assert.deepEqual(update.params, [81, "hot"]);
  const activity = queries.find(({ sql }) => /INSERT INTO lead_activities/.test(sql));
  assert.equal(activity.params[3], "Rule automation");
  assert.equal(activity.params[4].source, "conversation_rules");
  assert.equal(activity.params[4].matchedRule, "booking_intent");
  assert.deepEqual(published, [{ event: "pipeline_changed", payload: { leadId: 81 } }]);
});

test("a staff temperature change locks out automatic updates", async (t) => {
  const originalConnect = pool.connect;
  const originalPublish = realtimeEvents.publish;
  t.after(() => {
    pool.connect = originalConnect;
    realtimeEvents.publish = originalPublish;
  });
  let update = null;
  const current = {
    id: 84,
    temperature: "warm",
    temperature_locked: false,
    stage_id: 1,
    stage_name: "New Lead",
    stage_type: "open",
    is_closed: false,
  };
  pool.connect = async () => ({
    query: async (sql, params) => {
      if (/SELECT l\.\*, s\.name AS stage_name/.test(sql)) return { rows: [current] };
      if (/UPDATE leads SET/.test(sql)) {
        update = { sql, params };
        return { rows: [{ ...current, temperature: "hot", temperature_locked: true }] };
      }
      return { rows: [] };
    },
    release: () => {},
  });
  realtimeEvents.publish = () => {};

  await pipelineRepo.updateLead(84, { temperature: "hot" }, "staff@example.com");

  assert.match(update.sql, /temperature_locked/);
  assert.match(update.sql, /temperature_source/);
  assert.ok(update.params.includes(true));
  assert.ok(update.params.includes("manual"));
});

test("rule-based temperature update cannot overwrite a lead that is no longer Warm", async (t) => {
  const originalConnect = pool.connect;
  const originalPublish = realtimeEvents.publish;
  t.after(() => {
    pool.connect = originalConnect;
    realtimeEvents.publish = originalPublish;
  });

  let activityWritten = false;
  pool.connect = async () => ({
    query: async (sql) => {
      if (/UPDATE leads/.test(sql)) return { rows: [] };
      if (/INSERT INTO lead_activities/.test(sql)) activityWritten = true;
      return { rows: [] };
    },
    release: () => {},
  });
  realtimeEvents.publish = () => {
    throw new Error("A skipped automatic update should not publish an event");
  };

  const updated = await pipelineRepo.applyRuleBasedTemperature(82, {
    temperature: "cold",
    matchedRule: "explicit_rejection",
    reason: "The customer explicitly declined.",
    evidence: "No thanks, I am not interested.",
  });

  assert.equal(updated, null);
  assert.equal(activityWritten, false);
});

test("repository rejects a rule result that is not Hot or Cold", async (t) => {
  const originalConnect = pool.connect;
  t.after(() => {
    pool.connect = originalConnect;
  });

  pool.connect = async () => {
    throw new Error("An unqualified suggestion must not reach the database");
  };

  assert.equal(await pipelineRepo.applyRuleBasedTemperature(83, {
    temperature: "warm",
    matchedRule: "general_interest",
    reason: "The customer asked about pricing.",
    evidence: "How much is it?",
  }), null);
});
