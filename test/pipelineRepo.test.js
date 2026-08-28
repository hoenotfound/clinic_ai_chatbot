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
        return { rows: [{ id: 2, name: "New Lead" }] };
      }
      if (/INSERT INTO leads/.test(sql)) {
        assert.match(sql, /ON CONFLICT \(contact_id\) WHERE is_closed = false DO NOTHING/);
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

  const result = await pipelineRepo.ensureLeadForContact(7, "Automation");

  assert.equal(result.created, true);
  assert.equal(result.lead.id, 41);
  assert.equal(queries[0].sql, "BEGIN");
  assert.equal(queries.at(-1).sql, "COMMIT");
  assert.equal(released, true);
  assert.deepEqual(published, [{ event: "pipeline_changed", payload: { leadId: 41 } }]);
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
  assert.match(insertSql, /ON CONFLICT \(contact_id\) WHERE is_closed = false DO NOTHING/);
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
});

test("automatic temperature update is atomic and only claims a still-Warm lead", async (t) => {
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

  const updated = await pipelineRepo.applyAutomaticTemperature(81, {
    temperature: "hot",
    confidence: "high",
    enoughInformation: true,
    reason: "The customer accepted an appointment tomorrow.",
  });

  assert.equal(updated.temperature, "hot");
  const update = queries.find(({ sql }) => /UPDATE leads/.test(sql));
  assert.match(update.sql, /is_closed = false AND temperature = 'warm'/);
  assert.deepEqual(update.params, [81, "hot"]);
  const activity = queries.find(({ sql }) => /INSERT INTO lead_activities/.test(sql));
  assert.equal(activity.params[4].source, "conversation_temperature");
  assert.deepEqual(published, [{ event: "pipeline_changed", payload: { leadId: 81 } }]);
});

test("automatic temperature update cannot overwrite a lead that is no longer Warm", async (t) => {
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

  const updated = await pipelineRepo.applyAutomaticTemperature(82, {
    temperature: "cold",
    confidence: "high",
    enoughInformation: true,
    reason: "The customer explicitly declined.",
  });

  assert.equal(updated, null);
  assert.equal(activityWritten, false);
});

test("repository rejects an automatic temperature result without decisive confidence", async (t) => {
  const originalConnect = pool.connect;
  t.after(() => {
    pool.connect = originalConnect;
  });

  pool.connect = async () => {
    throw new Error("An unqualified suggestion must not reach the database");
  };

  assert.equal(await pipelineRepo.applyAutomaticTemperature(83, {
    temperature: "hot",
    confidence: "medium",
    enoughInformation: true,
    reason: "The customer asked about pricing.",
  }), null);
  assert.equal(await pipelineRepo.applyAutomaticTemperature(83, {
    temperature: "cold",
    confidence: "high",
    enoughInformation: false,
    reason: "The available evidence is ambiguous.",
  }), null);
});
