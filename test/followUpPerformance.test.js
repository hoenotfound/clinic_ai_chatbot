const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
if(process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
const report = require("../src/db/followUpPerformanceRepo");

test("Phase 7 validates bounded reporting filters",()=>{
  assert.deepEqual(report.parsePerformanceFilters(),{days:30,channel:"all"});
  assert.deepEqual(report.parsePerformanceFilters({days:"7",channel:"instagram"}),{days:7,channel:"instagram"});
  for(const filters of [{days:31},{days:-1},{days:"7.5"},{channel:"tiktok"}])
    assert.throws(()=>report.parsePerformanceFilters(filters),/Invalid performance filters/);
});

test("no accessible contacts does not query database",async()=>{
  let called=0;
  const response=await report.getFollowUpPerformance({},[],async()=>{called++;return{rows:[]};});
  assert.equal(response.summary.sent,0);
  assert.deepEqual(response.breakdown,[]);
  assert.equal(called,0);
});

test("Postgres Phase 7 attributes replies and milestones only to latest accepted touch",{
  skip:!process.env.TEST_DATABASE_URL && !process.env.CI,
},async()=>{
  assert.ok(process.env.TEST_DATABASE_URL, "CI requires TEST_DATABASE_URL to run PostgreSQL attribution coverage");
  const client=new Client({connectionString:process.env.TEST_DATABASE_URL,ssl:false});
  const schema="fu_perf_"+process.pid+"_"+Date.now();
  await client.connect();
  try{
    await client.query("CREATE SCHEMA "+schema);
    await client.query("SET search_path TO "+schema);
    await client.query("CREATE TABLE contacts(id integer primary key,channel text);\nCREATE TABLE messages(id integer primary key,contact_id integer,role text,created_at timestamptz,is_automated_follow_up boolean DEFAULT false,automated_follow_up_for_message_id integer,pricing_reminder_anchor_id integer,automated_follow_up_step integer,automated_follow_up_target_service text,automated_follow_up_parent_message_id integer,delivery_status text,media_url text,media_key text,media_mime_type text);\nCREATE TABLE leads(id integer primary key,contact_id integer,created_at timestamptz);\nCREATE TABLE pipeline_stages(id integer primary key,system_key text,stage_type text);\nCREATE TABLE lead_stage_history(lead_id integer,to_stage_id integer,created_at timestamptz);\nCREATE TABLE whatsapp_free_entry_followup_attempts(message_id integer,contact_id integer,status text);\nINSERT INTO contacts VALUES(1,'facebook'),(2,'instagram'),(3,'whatsapp'),(4,'whatsapp'),(5,'whatsapp');\nINSERT INTO leads VALUES(1,1,now()-interval '15 days'),(2,2,now()-interval '3 days'),(4,4,now()-interval '15 days');\nINSERT INTO pipeline_stages VALUES(1,'appointment_set','open'),(2,'visited','open'),(3,'won','won');\nINSERT INTO messages(id,contact_id,role,created_at,is_automated_follow_up,automated_follow_up_for_message_id,automated_follow_up_step,automated_follow_up_target_service,delivery_status) VALUES(10,1,'assistant',now()-interval '10 days',true,5,1,'3D','sent'),(11,1,'assistant',now()-interval '10 days'+interval '2 hours',true,5,2,'3D','delivered'),(20,2,'assistant',now()-interval '1 day',true,19,1,'9D','sent'),(30,3,'assistant',now()-interval '10 days',true,29,1,'Pelvis','failed');\nINSERT INTO messages(id,contact_id,role,created_at,is_automated_follow_up,pricing_reminder_anchor_id,automated_follow_up_step,automated_follow_up_target_service,delivery_status) VALUES(40,4,'assistant',now()-interval '10 days',true,39,4,'Pelvis','sent');\nINSERT INTO messages(id,contact_id,role,created_at) VALUES(50,1,'user',now()-interval '10 days'+interval '2 hours 30 minutes'),(51,2,'user',now()-interval '1 day'+interval '20 minutes'),(52,4,'user',now()-interval '10 days'+interval '1 hour');\nINSERT INTO messages(id,contact_id,role,created_at,is_automated_follow_up,automated_follow_up_parent_message_id,automated_follow_up_step,delivery_status,media_mime_type) VALUES(60,1,'assistant',now()-interval '10 days'+interval '2 hours 1 minute',true,11,1,'sent','video/mp4');\nINSERT INTO messages(id,contact_id,role,created_at,is_automated_follow_up,automated_follow_up_parent_message_id,automated_follow_up_step,delivery_status,media_url) VALUES(61,1,'assistant',now()-interval '10 days'+interval '2 hours 1 minute',true,10,1,'failed','https://example.com/not-sent.jpg');\nINSERT INTO lead_stage_history VALUES(1,1,now()-interval '10 days'+interval '3 hours'),(1,3,now()-interval '10 days'+interval '4 hours'),(4,2,now()-interval '10 days'+interval '2 hours');\nINSERT INTO messages(id,contact_id,role,created_at,is_automated_follow_up,delivery_status) VALUES(70,5,'assistant',now()-interval '9 days',true,'sent'),(71,5,'assistant',now()-interval '9 days',true,'sent'),(72,5,'assistant',now()-interval '9 days',true,'unknown');\nINSERT INTO whatsapp_free_entry_followup_attempts VALUES(70,5,'accepted'),(71,5,'cancelled'),(72,5,'accepted');\nINSERT INTO messages(id,contact_id,role,created_at) VALUES(73,5,'user',now()-interval '9 days'+interval '3 hours');");
    const q=(sql,params)=>{assert.match(sql,/^\s*WITH eligible/);return client.query(sql,params);};
    const profile={primarySystemKey:"appointment_set",secondarySystemKey:"visited"};
    const all=await report.getFollowUpPerformance({days:30},null,q,profile);
    assert.equal(all.summary.sent,5,"four parent/pricing and one accepted FEP; rejected and media excluded");
    assert.equal(all.summary.contacts,4);
    assert.equal(all.summary.replied_observed,4,"one attributed reply per contact/touch");
    assert.equal(all.summary.replied_matured,3);
    assert.equal(all.summary.reply_matured,4);
    assert.equal(all.summary.appointments_observed,1);
    assert.equal(all.summary.visits_observed,1);
    assert.equal(all.summary.visits_matured,1);
    assert.equal(all.summary.avg_reply_hours,1.5, "Exclude immature replies from mature average");
    assert.equal(all.summary.won_observed,1);
    const steps=Object.fromEntries(all.breakdown.filter(x=>x.dimension==="step").map(x=>[x.label,x]));
    assert.equal(steps.FU1.replied_observed,1,"FU1 cannot claim FU2 reply");
    assert.equal(steps.FU2.replied_observed,1);
    assert.equal(steps.FU2.appointments_observed,1);
    assert.equal(steps.FU2.won_observed,1);
    assert.equal(steps.Pricing.visits_observed,1);
    assert.equal(steps.Pricing.visits_matured,1);
    assert.equal(steps["Extended WA template"].sent,1);
    assert.equal(steps["Extended WA template"].replied_matured,1);
    const media=Object.fromEntries(all.breakdown.filter(x=>x.dimension==="media").map(x=>[x.label,x]));
    assert.equal(media.Video.sent,1);
    assert.equal(media["Text / no accepted media"].sent,4);
    assert.equal(all.daily.reduce((sum,row)=>sum+row.sent,0),5);
    // Media with a filename but no MIME type must classify correctly.
    await client.query("UPDATE messages SET media_key='testimonials/proof.mp4?download=1' WHERE id=40");
    const filenameMedia=await report.getFollowUpPerformance({days:30},null,q,profile);
    assert.equal(filenameMedia.breakdown.find(x=>x.dimension==='media' && x.label==='Video').sent,2);
    await client.query("UPDATE messages SET media_key=NULL,media_mime_type='application/pdf',media_url='https://example.com/file.pdf' WHERE id=40");
    const documentReport=await report.getFollowUpPerformance({days:30},null,q,profile);
    assert.equal(documentReport.breakdown.find(row=>row.dimension==='media'&&row.label==='Other / unknown media').sent,1);
    await client.query("INSERT INTO messages(id,contact_id,role,created_at) VALUES(74,5,'user',now()-interval '9 days'+interval '4 hours')");
    const repeatReplies=await report.getFollowUpPerformance({days:30},null,q,profile);
    assert.equal(repeatReplies.summary.replied_observed,4,'multiple replies must count as one responsive follow-up');
    await client.query("INSERT INTO leads VALUES(6,3,now()-interval '15 days'); INSERT INTO lead_stage_history VALUES(6,3,now()-interval '9 days'); UPDATE messages SET delivery_status='sent' WHERE id=30");
    const directWon=await report.getFollowUpPerformance({days:30},null,q,profile);
    assert.equal(directWon.summary.appointments_matured,2);
    assert.equal(directWon.summary.visits_matured,2);
    assert.equal(directWon.summary.won_matured,2);
    const scoped=await report.getFollowUpPerformance({days:30},[1],q,profile);
    assert.equal(scoped.summary.sent,2);
    assert.equal(scoped.summary.replied_matured,1);
    const instagram=await report.getFollowUpPerformance({days:30,channel:"instagram"},null,q,profile);
    assert.equal(instagram.summary.sent,1);
    assert.equal(instagram.summary.reply_matured,0);
  }finally{
    await client.query("SET search_path TO public");
    await client.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE");
    await client.end();
  }
});
