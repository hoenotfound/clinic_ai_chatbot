const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
const { beforeExpiryDueSql } = require("../src/utils/followUpAdaptiveTiming");
const health = require("../src/db/followUpHealthScheduleRepo");

test("Phase 6 timing SQL reuses exactly the worker's before-expiry calculator", () => {
  const config = {
    enabled: true, triggerMode: "all", activatedAt: "2026-10-01T00:00:00Z",
    delayMinutes: 120,
    additionalSteps: [{ delayMinutes: 360 },
      { timingMode: "before_window_expiry", beforeWindowExpiryMinutes: 120 }],
    quietHours: { enabled: true, start: "00:00", end: "07:00" },
    pricingReminder: { enabled: true, enableSocialChannels: true },
  };
  const settings = health.normalizeTimingSettings(config);
  assert.ok(settings);
  assert.deepEqual(settings.delays, [120,360,1320]);
  const sql = health.buildScheduleSql(settings);
  const workerDue = beforeExpiryDueSql({
    inbound: "inbound_at", previous: "previous_at", step: "next_step",
    offset: "($7::integer[])[next_step]",
    gap: "(($5::integer[])[next_step] - ($5::integer[])[next_step - 1])",
    quietHours: config.quietHours,
    reservePricingMinutes: 5, reservePricingOnSocial: true, channel: "channel",
  });
  assert.ok(sql.includes(workerDue), "monitoring must share worker pre-expiry SQL");
  assert.match(sql, /next_step <> 3 OR GREATEST\(due_at, now\(\)\) < inbound_at \+ interval '23 hours 35 minutes'/);
  assert.match(sql, /anchor\.sent_by_username IS NOT NULL/);
  assert.match(sql, /lead\.is_closed = false/);
  assert.match(sql, /c\.channel_user_id IS NOT NULL/);
  assert.match(sql, /c\.social_opt_out_at IS NOT NULL/);
  assert.match(sql, /c\.mode,'ai'/);
  assert.match(sql, /due_now_policy_review/);
  assert.doesNotMatch(sql, /AND COALESCE\(c\.mode,'ai'\) <> 'human'/);
});

test("Phase 6 supports legacy one-step, two-step, and three-step follow-up configurations", () => {
  const base = {
    enabled:true, triggerMode:"all", activatedAt:"2026-10-01T00:00:00Z",
    delayMinutes:120, quietHours:{ enabled:true,start:"00:00",end:"07:00" },
  };
  const single = health.normalizeTimingSettings(base);
  assert.ok(single);
  assert.deepEqual(single.delays,[120]);
  const two = health.normalizeTimingSettings({...base,additionalSteps:[{delayMinutes:360}]});
  assert.ok(two);
  assert.deepEqual(two.delays,[120,360]);
  const three = health.normalizeTimingSettings({...base,additionalSteps:[
    {delayMinutes:360},{timingMode:"before_window_expiry",beforeWindowExpiryMinutes:120},
  ]});
  assert.ok(three);
  assert.deepEqual(three.delays,[120,360,1320]);
  assert.equal(health.normalizeTimingSettings({...base,additionalSteps:null}),null);
  assert.equal(health.normalizeTimingSettings({...base,additionalSteps:[{delayMinutes:90}]}),null);
});

test("real PostgreSQL calculator shifts FU3 from 1 AM to 11:30 PM local before quiet hours", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL, ssl: false });
  await client.connect();
  try {
    // Incoming at 03:00 Malaysia time, due nominally at 01:00 next day.
    // FU2 at 20:30 gives a 22:30 earliest 2-hour gap, allowing an early FU3.
    const due = beforeExpiryDueSql({
      inbound: "'2026-10-09T19:00:00Z'::timestamptz",
      previous: "'2026-10-10T12:30:00Z'::timestamptz",
      step: "3", offset: "120", gap: "240",
      quietHours: {enabled: true, start:"00:00", end:"07:00"},
      timeZone:"Asia/Kuala_Lumpur",
      reservePricingMinutes:5, reservePricingOnSocial:true,
      channel:"'facebook'",
    });
    const result = await client.query("SELECT " + due + " AS due_at");
    assert.equal(new Date(result.rows[0].due_at).toISOString(), "2026-10-10T15:30:00.000Z");
  } finally {
    await client.end();
  }
});

test("monitoring adjusts ordinary in-quiet-hour estimates and rejects expired windows", () => {
  const now = new Date("2026-10-10T16:00:00Z"); // Midnight Malaysia
  const quietHours = { enabled:true,start:"00:00",end:"07:00" };
  const rows = [
    {contact_id:1,channel:"facebook",next_step:2,
      due_at:"2026-10-10T16:20:00Z",inbound_at:"2026-10-10T10:00:00Z"},
    {contact_id:2,channel:"whatsapp",next_step:3,
      due_at:"2026-10-10T16:20:00Z",inbound_at:"2026-10-09T17:00:00Z"},
  ];
  const result = health.estimateUpcoming(rows,{quietHours},now);
  assert.deepEqual(result.map(r=>r.contact_id),[1]);
  assert.equal(result[0].estimated_at,"2026-10-10T23:00:00.000Z");
});

test("invalid or globally disabled timing configurations are never presented as scheduled sends", () => {
  const valid = { enabled:true, triggerMode:"all", activatedAt:"2026-10-01T00:00:00Z",
    delayMinutes:120,additionalSteps:[],
    quietHours:{enabled:true,start:"00:00",end:"07:00"} };
  assert.equal(health.normalizeTimingSettings({...valid,triggerMode:"none"}),null);
  assert.equal(health.normalizeTimingSettings({...valid,additionalSteps:[{delayMinutes:30}]}),null);
  assert.equal(health.normalizeTimingSettings({...valid,activatedAt:"invalid"}),null);
});
