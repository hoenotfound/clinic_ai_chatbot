const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const guard = require("../src/services/whatsappZeroCostGuard");
const clinicConfig = require("../src/config/clinicConfig");

function mode(t, enabled = true) {
  const previous = clinicConfig.automatedFollowUp;
  clinicConfig.automatedFollowUp = {
    ...(previous || {}),
    whatsappFreeOnly: {
      enabled,
      activatedAt: enabled ? "2026-10-09T00:00:00.000Z" : null,
    },
  };
  t.after(() => { clinicConfig.automatedFollowUp = previous; });
}

function fakeDatabase({ billed = false, eligible = false, crash = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (crash) throw new Error("Postgres not reachable");
      if (sql.includes("AS tripped")) return { rows: [{ tripped: billed }] };
      if (sql.includes("AS eligible")) return { rows: [{ eligible }] };
      throw new Error("Unexpected query");
    },
  };
}

test("free-only mode OFF leaves existing WhatsApp sending behaviour unchanged", async (t) => {
  mode(t, false);
  const db = fakeDatabase({ crash: true });
  assert.deepEqual(await guard.authorize("+60 11-3053 5053", { database: db }), { allowed: true });
  assert.equal(db.calls.length, 0);
});

test("free-only mode blocks direct WhatsApp, open service windows and unverified ad clicks", async (t) => {
  mode(t);
  const db = fakeDatabase();
  const result = await guard.authorize("+60 11-3053 5053", { database: db });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "zero_cost_unverified_free_entry");
  assert.equal(db.calls.length, 2);
});

test("free-only mode permits only a verified and fully reconciled free-entry session", async (t) => {
  mode(t);
  const db = fakeDatabase({ eligible: true });
  const result = await guard.authorize("601130535053", {
    database: db, now: new Date("2026-10-09T06:30:00.000Z"),
  });
  assert.deepEqual(result, { allowed: true });
  assert.deepEqual(db.calls[1].params, [72, "2026-10-09T06:30:00.000Z", "601130535053"]);
});

test("any billable Meta callback since activation trips the entire account stop", async (t) => {
  mode(t);
  const db = fakeDatabase({ billed: true, eligible: true });
  const result = await guard.authorize("601130535053", { database: db });
  assert.equal(result.code, "zero_cost_billing_alarm");
  assert.equal(db.calls.length, 1);
});

test("missing account evidence fails closed during database outages", async (t) => {
  mode(t);
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  const result = await guard.authorize("601130535053", { database: fakeDatabase({ crash: true }) });
  assert.equal(result.code, "zero_cost_database_unavailable");
  assert.equal(guard.blockedResult(result).retryable, false);
});

test("strict query requires Meta free-entry pricing for every previously accepted outbound message", () => {
  assert.match(guard.VERIFIED_WINDOW_SQL, /start_bill\.pricing_type='free_entry_point'/);
  assert.match(guard.VERIFIED_WINDOW_SQL, /start_bill\.billable=false/);
  assert.match(guard.VERIFIED_WINDOW_SQL, /prior\.not\.real|priced\.wamid IS NULL/);
  assert.match(guard.VERIFIED_WINDOW_SQL, /attempt\.status IN \('sending','failed','unknown'\)/);
  assert.match(guard.VERIFIED_WINDOW_SQL, /\$1::integer - 1/);
});

test("all raw Cloud API message senders and template sender use central guard", () => {
  const raw = fs.readFileSync(path.join(__dirname,"../src/services/whatsappService.js"),"utf8");
  const templates = fs.readFileSync(path.join(__dirname,"../src/services/whatsappTemplateService.js"),"utf8");
  assert.equal((raw.match(/whatsappZeroCostGuard\.authorize\(to\)/g) || []).length, 7);
  assert.match(templates, /whatsappZeroCostGuard\.authorize\(contact\?\.whatsapp_number\)/);
});

test("Tools setting survives normalization, saving and backend validation", () => {
  const tools = fs.readFileSync(path.join(__dirname,"../portal-frontend/src/pages/Tools.jsx"),"utf8");
  const config = fs.readFileSync(path.join(__dirname,"../src/routes/config.js"),"utf8");
  assert.match(tools, /Block potentially paid WhatsApp sends/);
  assert.match(tools, /whatsappFreeOnly: \{ enabled: form\.whatsappFreeOnly\?\.enabled === true \}/);
  assert.match(config, /requested\.whatsappFreeOnly \?\? current\?\.whatsappFreeOnly/);
  assert.match(config, /sameFreeOnlyRun/);
});
