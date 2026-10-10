const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { pool } = require("../src/db/db");
const health = require("../src/db/followUpHealthRepo");

test("health filters reject unknown channels and oversized periods", () => {
  assert.deepEqual(health.parseHealthFilters({ days:"30", channel:"facebook" }), { days:30, channel:"facebook" });
  for(const filters of [{days:31},{days:-1},{channel:"other"}]){
    assert.throws(()=>health.parseHealthFilters(filters), /Invalid health filters/);
  }
});

test("no authorized leads means no health or upcoming database access", async()=>{
  let calls=0;
  const execute=async()=>{calls++;return {rows:[]};};
  assert.equal((await health.getFollowUpHealth({},[],execute)).eventCount,0);
  assert.deepEqual(await health.getUpcomingReviewQueue({channel:"all"},[],{enabled:true},execute),{upcoming:[],dueNowCount:0});
  assert.equal(calls,0);
});

test("next-step estimates are limited to active reply windows and never treated as authorization",()=>{
  const now=new Date("2026-10-10T12:00:00Z");
  const cfg={quietHours:{enabled:false,start:"00:00",end:"07:00"}};
  const valid={contact_id:1,channel:"facebook",next_step:2,
    due_at:"2026-10-10T13:00:00Z",inbound_at:"2026-10-10T02:00:00Z"};
  const result=health.estimateUpcoming([valid,{...valid,contact_id:2,
      inbound_at:"2026-10-09T02:00:00Z"}],cfg,now);
  assert.equal(result.length,1);
  assert.equal(result[0].step,2);
  assert.match(result[0].reason,/Worker-derived estimate/);
});

test("PostgreSQL follow-up monitoring counts persisted evidence separately from companion media",{
  skip:!process.env.TEST_DATABASE_URL,
},async()=>{
  const client=new Client({connectionString:process.env.TEST_DATABASE_URL,ssl:false});
  const schema="fu_health_"+process.pid+"_"+Date.now();
  await client.connect();
  try{
    await client.query("CREATE SCHEMA "+schema);
    await client.query("SET search_path TO "+schema);
    await client.query(`
      CREATE TABLE contacts(id integer primary key,channel text,needs_attention boolean default false,
        mode text default 'ai', whatsapp_number text, channel_user_id text,
        whatsapp_opt_out_at timestamptz,whatsapp_marketing_opt_out_at timestamptz,
        social_opt_out_at timestamptz,social_marketing_opt_out_at timestamptz,
        attention_reason text, updated_at timestamptz default now());
      CREATE TABLE messages(
        id integer primary key, contact_id integer,role text, created_at timestamptz default now(),
        delivery_status text,delivery_error text,whatsapp_message_id text,
        is_automated_follow_up boolean default false,
        automated_follow_up_step integer default 1,
        automated_follow_up_for_message_id integer,
        automated_follow_up_parent_message_id integer,
        pricing_reminder_anchor_id integer,sent_by_username text,
        automated_follow_up_target_service text
      );
      CREATE TABLE follow_up_ai_decisions(id integer,contact_id integer,trigger_message_id integer,
        action text,follow_up_step integer,reason text,created_at timestamptz default now());
      CREATE TABLE pricing_reminder_decisions(id integer,contact_id integer,created_at timestamptz default now(),reason text);
      CREATE TABLE outbound_message_evidence(message_id integer,origin text);
      CREATE TABLE leads(id integer primary key,contact_id integer,treatment_interest text,
        is_closed boolean default false, appointment_status text,stage_id integer,
        created_at timestamptz default now());
      CREATE TABLE pipeline_stages(id integer primary key,stage_type text,system_key text);
      INSERT INTO contacts(id,channel,channel_user_id) VALUES(1,'facebook','fb1'),(2,'instagram','ig2');
      INSERT INTO leads(id,contact_id,treatment_interest) VALUES(1,1,'3D'),(2,2,'Pelvis');
      INSERT INTO messages(id,contact_id,role,is_automated_follow_up,automated_follow_up_for_message_id,automated_follow_up_step,delivery_status)
        VALUES(10,1,'assistant',true,8,3,'sent'),(20,2,'assistant',true,18,2,'pending');
      INSERT INTO messages(id,contact_id,role,is_automated_follow_up,automated_follow_up_parent_message_id,delivery_status,delivery_error)
        VALUES(11,1,'assistant',true,10,'failed','Video rejected');
      UPDATE messages SET created_at=now()-interval '25 minutes' WHERE id=20;
      INSERT INTO follow_up_ai_decisions(id,contact_id,trigger_message_id,action,follow_up_step,reason)
        VALUES (201,1,10,'skip',2,'customer booked');
      INSERT INTO pricing_reminder_decisions(id,contact_id,reason)
        VALUES (202,2,'delivery_review');
    `);
    const execute=(sql,params)=>client.query(sql,params);
    const all=await health.getFollowUpHealth({days:7,channel:"all"},null,execute);
    assert.equal(all.eventCount,5);
    assert.ok(all.breakdown.some(v=>v.service==="3D"&&v.step===3&&v.status==="sent"));
    assert.equal(all.failedCount,1);
    assert.equal(all.attentionCount,1);
    assert.equal(all.breakdown.some(v=>v.part==="decision"&&v.status==="skipped"),true);
    assert.equal(all.stalePendingCount,1);
    assert.equal(all.alerts.length,3);
    assert.equal(all.breakdown.find(v=>v.part==="media").step,3);
    const denied=await health.getFollowUpHealth({days:7,channel:"all"},[2],execute);
    assert.equal(denied.eventCount,2);
    assert.equal(denied.alerts.length,2);
    const messenger=await health.getFollowUpHealth({days:7,channel:"facebook"},null,execute);
    assert.equal(messenger.eventCount,3);
    await client.query(`INSERT INTO contacts(id,channel,channel_user_id,needs_attention,attention_reason)
      VALUES(3,'instagram','ig3',true,
      'Follow-up text was sent, but its optional image was not queued because the parent follow-up record was unavailable. Check Inbox before attempting a manual resend.')`);
    const missingMedia = await health.getFollowUpHealth({days:7,channel:"all"},[3],execute);
    assert.equal(missingMedia.attentionCount,1);
    assert.equal(missingMedia.eventCount,1);
    assert.equal(missingMedia.alerts[0].part,"contact_alert");
    // Future review queue is based on the newest message cycle only.
    await client.query(`
      INSERT INTO messages(id,contact_id,role,created_at) VALUES(30,1,'user',now()-interval '4 hours');
      INSERT INTO messages(id,contact_id,role,created_at,sent_by_username,delivery_status)
      VALUES(31,1,'assistant',now()-interval '3 hours 59 minutes','bot','sent');
    `);
    const cfg={enabled:true,triggerMode:"all",activatedAt:"2026-10-01T00:00:00Z",
      delayMinutes:120,additionalSteps:[],quietHours:{enabled:false,start:"00:00",end:"07:00"}};
    const queue=await health.getUpcomingReviewQueue({channel:"facebook"},[1],cfg,execute);
    assert.equal(queue.upcoming.length,1);
    assert.equal(queue.upcoming[0].step,1);
    assert.equal(queue.upcoming[0].contact_id,1);
    assert.equal(queue.dueNowCount,1);
  }finally{
    await client.query("SET search_path TO public");
    await client.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE");
    await client.end();
  }
});
