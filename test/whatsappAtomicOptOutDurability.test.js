const test = require("node:test");
const assert = require("node:assert/strict");
const inbound = require("../src/db/inboundProcessingRepo");

test("new WhatsApp STOP is enforced atomically with the durable inbound and CRM state", async () => {
  for (const scope of ["marketing","all"]) {
    const calls=[];
    const database={
      async query(sql,params){
        calls.push({sql,params});
        return {rows:[{
          saved_inbound:{id:5,contact_id:2},
          processing_job:{id:7,message_id:5},
          derived_first_message:true,
        }]};
      }
    };
    const result=await inbound.storeInboundClaim({
      contactId:2,channel:"whatsapp",content:"Please stop sending me promotions",
      storedMessageId:"wamid.stop-test",optOutScope:scope,
      incoming:{timestamp:1791507600,text:"Please stop sending me promotions"}
    },database);
    assert.equal(result.savedInbound.id,5);
    assert.equal(calls.length,1,"message + opt-out must be one SQL statement");
    const {sql,params}=calls[0];
    assert.match(sql,/enforced_whatsapp_stop AS \(/);
    assert.match(sql,/synchronized_stop_leads AS \(/);
    assert.match(sql,/UPDATE leads SET marketing_consent='opted_out'/);
    assert.match(sql,/EXISTS\(SELECT 1 FROM inserted_message\)/);
    assert.match(sql,/whatsapp_opt_in_at <= COALESCE\(\$6::timestamptz,now\(\)\)/);
    assert.equal(params[8],scope);
    assert.match(params[5],/^2026-/);
  }
});

test("ordinary enquiries remain free of STOP-specific durability CTEs", async ()=>{
  for (const channel of ["whatsapp","facebook"]) {
    const calls=[];
    const database={async query(sql,params){
      calls.push({sql,params});
      return {rows:[]};
    }};
    await inbound.storeInboundClaim({
      contactId:3,channel,content:"I want treatment",
      storedMessageId:"wamid.generic",optOutScope:null,
      incoming:{text:"I want treatment"},
    },database);
    assert.equal(calls[0].params.length,8);
    assert.doesNotMatch(calls[0].sql,/enforced_whatsapp_stop/);
  }
});

test("Facebook and Instagram STOP is persisted atomically before reply-worker leasing", async () => {
  for (const channel of ["facebook", "instagram"]) {
    for (const optOutScope of ["marketing", "all"]) {
      const calls = [];
      const database = { async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{
          saved_inbound: { id: 58, contact_id: 12 },
          processing_job: { id: 71, message_id: 58 },
          derived_first_message: false,
        }] };
      }};
      const result = await inbound.storeInboundClaim({
        contactId: 12, channel,
        content: "Stop promotions. How long is the pelvic treatment?",
        storedMessageId: channel + ":social-stop-1",
        optOutScope, incoming: {
          id: "social-stop-1", text: "Stop promotions. How long is the pelvic treatment?",
        },
      }, database);
      assert.equal(result?.savedInbound.id, 58);
      assert.equal(calls.length, 1, "social opt-out is enforced in the message INSERT");
      const { sql, params } = calls[0];
      assert.match(sql, /enforced_social_stop AS \(/);
      assert.match(sql, /synchronized_social_stop_leads AS \(/);
      assert.match(sql, /EXISTS\(SELECT 1 FROM inserted_message\)/);
      assert.match(sql, /social_marketing_opt_out_at = now\(\)/);
      assert.match(sql, /ON CONFLICT \(whatsapp_message_id\) DO NOTHING/);
      assert.equal(params[8], optOutScope);
      assert.equal(params[3], channel);
      assert.equal(JSON.parse(params[4])._socialStopEnforcedAtomically, true);
    }
  }
});
