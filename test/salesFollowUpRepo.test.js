const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pool } = require("../src/db/db");
const repo = require("../src/db/salesFollowUpRepo");

test("sales follow-up candidate query applies owner and journey scoping in SQL", async (t) => {
  const previousQuery = pool.query;
  t.after(() => { pool.query = previousQuery; });
  let captured;
  pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  const leads = await repo.listPending({ username: "sales-a", canViewAll: false, leadId: 99 });
  assert.deepEqual(leads, []);
  assert.match(captured.sql, /\(\$1::boolean OR l\.owner_username = \$2::text\)/);
  assert.match(captured.sql, /l\.started_message_id/);
  assert.match(captured.sql, /m\.role = 'user'/);
  assert.match(captured.sql, /staff\.sent_by_username IS NOT NULL/);
  assert.match(captured.sql, /whatsapp_free_entry_referrals/);
  assert.match(captured.sql, /whatsapp_free_entry_pricing_evidence/);
  assert.match(captured.sql, /score.updated_at > t.updated_at/);
  assert.equal(captured.params[0], false);
  assert.equal(captured.params[1], "sales-a");
  assert.equal(captured.params[3], 99);
  assert.equal(captured.params[6], 500);
});

test("global query visibility follows caller view_all_leads permission", async (t) => {
  const previousQuery = pool.query;
  t.after(() => { pool.query = previousQuery; });
  let params;
  pool.query = async (sql, args) => { params = args; return { rows: [] }; };
  await repo.listPending({ username: "manager", canViewAll: true });
  assert.equal(params[0], true);
  assert.equal(params[1], "manager");
});

test("route requires export permission and a fresh server-side candidate list", () => {
  const route = fs.readFileSync(path.join(__dirname, "../src/routes/salesFollowUp.js"), "utf8");
  assert.match(route, /hasCapability\(req\.user, "export_customer_data"\)/);
  assert.match(route, /"Cache-Control": "no-store"/);
  assert.match(route, /customerExportRepo\.recordCustomerExport/);
  assert.match(route, /canManageAll\(req\)/);
  assert.match(route, /followUpRepo\.listPending/);
  assert.doesNotMatch(route, /sendWhatsAppMessage|sendMessage\(/);
});

test("manual booking writes stage history and stays independent from AI follow-up state", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/db/salesFollowUpRepo.js"), "utf8");
  assert.match(source, /INSERT INTO lead_stage_history/);
  assert.match(source, /INSERT INTO lead_activities/);
  assert.match(source, /FOR UPDATE/);
  assert.match(source, /Number\(eligible\[0\]\.lastInboundId\) !== inboundExpected/);
  assert.match(source, /UPDATE leads SET appointment_status='set'/);
  assert.doesNotMatch(source, /UPDATE messages SET/);
});
