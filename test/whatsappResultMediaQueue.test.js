const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zeroCost = require("../src/services/whatsappZeroCostGuard");
const whatsappPolicy = require("../src/services/whatsappPolicyService");
const messagesRepo = require("../src/db/messagesRepo");
const conversationStore = require("../src/utils/conversationStore");
const queue = require("../src/services/whatsappResultMediaQueue");
const { resultMediaAuditOutcome } = require("../src/utils/resultMediaAudit");

const sample = () => ({
  id: 9, lease_token: "11111111-1111-4111-8111-111111111111",
  contact_id: 443, inbound_message_id: 1503,
  image_url: "https://example.test/api/config/result-media/image/11",
  caption: "Customer result", sequence_no: 0,
  created_at: new Date().toISOString(),
});

function fakeDb(row) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("RETURNING contact_id,inbound_message_id")) return {rows:[]};
      if (sql.includes("RETURNING q.inbound_message_id")) return {rows:[]};
      if (sql.includes("RETURNING q.*")) return {rows:[row]};
      return {rows:[],rowCount:1};
    },
  };
}

function mock(t, target, name, replacement) {
  const original = target[name];
  target[name] = replacement;
  t.after(() => { target[name] = original; });
}

test("RM0 transient block postpones optional image without calling Meta or creating a failed message",async t=>{
  const row = sample();
  const db = fakeDb(row);
  mock(t,whatsappPolicy,"checkFreeformAllowed",async()=>({allowed:true}));
  mock(t,messagesRepo,"wasMediaRecentlySent",async()=>false);
  mock(t,messagesRepo,"hasUnconfirmedMediaDelivery",async()=>false);
  mock(t,zeroCost,"preflightFreeform",async()=>({
    allowed:false,code:"zero_cost_previous_send_unreconciled",
  }));
  let sent = 0;
  await queue.runOne({
    db,strictEnabled:()=>true,eligibility:async()=>({channel:"whatsapp",whatsapp_number:"60125023908"}),
    sender:async()=>{sent++;throw Error("must not send");},
  });
  assert.equal(sent,0);
  assert.equal(db.calls.some(x=>x.sql.includes("SET status='pending'")),true);
  assert.equal(db.calls.some(x=>x.sql.includes("SET status=$3") &&
    x.params?.includes("failed")),false);
});

test("when pricing confirms RM0, an image is accepted and its audit can be reconciled",async t=>{
  const row = sample();
  const db = fakeDb(row);
  mock(t,whatsappPolicy,"checkFreeformAllowed",async()=>({allowed:true}));
  mock(t,messagesRepo,"wasMediaRecentlySent",async()=>false);
  mock(t,messagesRepo,"hasUnconfirmedMediaDelivery",async()=>false);
  mock(t,zeroCost,"preflightFreeform",async()=>({allowed:true}));
  mock(t,conversationStore,"appendMessageForContact",async()=>({id:991}));
  let persisted = null;
  mock(t,messagesRepo,"setWhatsappMessageId",async(id,wamid)=>{persisted={id,wamid};});
  let sendCount = 0;
  await queue.runOne({
    db,strictEnabled:()=>true,eligibility:async()=>({channel:"whatsapp",whatsapp_number:"60125023908"}),
    sender:async(_contact,_url,_caption,opts)=>{
      sendCount++;
      assert.equal(opts.currentMessageId,991);
      assert.ok(db.calls.some(x=>x.sql.includes("SET message_id=$3") &&
        x.params?.[2]===991),
        "provider call must be preceded by a durable queue-to-message link");
      return {success:true,wamid:"wamid.verified"};
    },
  });
  assert.equal(sendCount,1);
  assert.deepEqual(persisted,{id:991,wamid:"wamid.verified"});
  assert.equal(db.calls.some(x=>x.sql.includes("SET status=$3") && x.params?.includes("sent")),true);
  assert.equal(db.calls.some(x=>x.sql.includes("THEN totals.result_confirmed ELSE d.result_images_sent END")),true);
});

test("queue writes all images transactionally, never inserting a failed delivery row",async t=>{
  mock(t,zeroCost,"enabled",()=>true);
  const statements = [];
  const database={
    async connect() {
      return {
        async query(sql,params){statements.push({sql,params});return {rows:[]};},
        release(){statements.push({sql:"released"});},
      };
    },
  };
  const inserted=await queue.enqueue({
    contactId:443,inboundMessageId:1503,
    items:[{imageUrl:"https://example.test/11",caption:"First"},
      {imageUrl:"https://example.test/12",caption:"Second"}],
  },database);
  assert.equal(inserted,true);
  assert.equal(statements.filter(x=>x.sql.includes("INSERT INTO whatsapp_result_media_queue")).length,2);
  assert.deepEqual(statements.map(x=>x.sql).filter(x=>["BEGIN","COMMIT"].includes(x)),
    ["BEGIN","COMMIT"]);
});

test("deferred result audits are not mistaken for provider delivery failures",()=>{
  assert.deepEqual(resultMediaAuditOutcome({
    reason:"awaiting_meta_free_billing",sentCount:0,
  }),{status:"deferred",reason:"awaiting_meta_free_billing"});
});

test("queued sends retain crash safety and no initial reply delay",()=>{
  const service=fs.readFileSync(path.join(__dirname,"../src/services/whatsappResultMediaQueue.js"),"utf8");
  const server=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  assert.match(service,/worker_interrupted_provider_outcome_unknown/);
  assert.match(service,/UNIQUE|ON CONFLICT\(inbound_message_id,sequence_no\)/);
  assert.match(server,/await whatsappResultMediaQueue.enqueue/);
  assert.ok(server.indexOf("await sendTrackedText(")<server.indexOf("await whatsappResultMediaQueue.enqueue("));
});

test("price graphics precede result examples, sharing one sequence without duplicates",async t=>{
  mock(t,zeroCost,"enabled",()=>true);
  const rows=[];
  const db={async connect(){return {
    async query(sql,params){
      if(sql.includes("INSERT INTO whatsapp_result_media_queue")) rows.push(params);
      return {rows:[]};
    },release(){},
  };}};
  await queue.enqueue({contactId:443,inboundMessageId:1503,kind:"promotion",
    items:[{imageUrl:"https://example.test/priceA",caption:"Package A"},
           {imageUrl:"https://example.test/priceB",caption:"Package B"}]},db);
  await queue.enqueue({contactId:443,inboundMessageId:1503,kind:"result",sequenceOffset:2,
    items:[{imageUrl:"https://example.test/result",caption:"Result example"}]},db);
  assert.deepEqual(rows.map(params=>params[2]),[0,1,2]);
  assert.deepEqual(rows.map(params=>params[3]),["promotion","promotion","result"]);
  assert.equal(new Set(rows.map(params=>params[2])).size,3);
});

test("confirmed billing alarm never calls the image sender",async t=>{
  const row=sample();
  const db=fakeDb(row);
  const contactsRepo=require("../src/db/contactsRepo");
  mock(t,contactsRepo,"setDeliveryAttention",async()=>null);
  mock(t,whatsappPolicy,"checkFreeformAllowed",async()=>({allowed:true}));
  mock(t,messagesRepo,"wasMediaRecentlySent",async()=>false);
  mock(t,messagesRepo,"hasUnconfirmedMediaDelivery",async()=>false);
  mock(t,zeroCost,"preflightFreeform",async()=>({
    allowed:false,code:"zero_cost_billing_alarm",
  }));
  let called=0;
  await queue.runOne({
    db,strictEnabled:()=>true,eligibility:async()=>({channel:"whatsapp",whatsapp_number:"60125023908"}),
    sender:async()=>{called++;return {success:true,wamid:"should-not-send"};},
  });
  assert.equal(called,0);
  assert.ok(db.calls.some(x=>x.sql.includes("SET status=$3") &&
    x.params?.includes("cancelled")));
});

test("optional images yield to waiting customer text replies",async t=>{
  const row=sample();
  const db=fakeDb(row);
  const query=db.query.bind(db);
  db.query=async(sql,params)=>sql.includes("FROM inbound_processing_jobs j")
    ? {rows:[{busy:true}]} : query(sql,params);
  mock(t,whatsappPolicy,"checkFreeformAllowed",async()=>({allowed:true}));
  mock(t,messagesRepo,"wasMediaRecentlySent",async()=>false);
  mock(t,messagesRepo,"hasUnconfirmedMediaDelivery",async()=>false);
  mock(t,zeroCost,"preflightFreeform",async()=>{
    throw Error("billing preflight should not compete with urgent reply");
  });
  let sent=false;
  await queue.runOne({
    db,strictEnabled:()=>true,eligibility:async()=>({channel:"whatsapp",whatsapp_number:"60125023908"}),
    sender:async()=>{sent=true;},
  });
  assert.equal(sent,false);
  assert.ok(db.calls.some(x=>x.sql.includes("SET status='pending'") &&
    x.params?.includes("priority_to_live_customer_reply")));
});

test("switching RM0 protection off never drains a previously queued strict-only image",async()=>{
  const row=sample();
  const db=fakeDb(row);
  let sent=0;
  await queue.runOne({
    db,strictEnabled:()=>false,
    eligibility:async()=>{ throw Error("must not evaluate image eligibility"); },
    sender:async()=>{sent++;},
  });
  assert.equal(sent,0);
  assert.ok(db.calls.some(x=>x.sql.includes("SET status=$3") &&
    x.params?.includes("strict_rm0_switched_off_after_queue")));
});

test("ordinary 24h freeform window closing never passes a deferred photo",async t=>{
  const row=sample(),db=fakeDb(row);
  mock(t,whatsappPolicy,"checkFreeformAllowed",async()=>({
    allowed:false,code:"outside_customer_service_window",
  }));
  mock(t,messagesRepo,"wasMediaRecentlySent",async()=>false);
  mock(t,messagesRepo,"hasUnconfirmedMediaDelivery",async()=>false);
  let preflight=0,sends=0;
  mock(t,zeroCost,"preflightFreeform",async()=>{preflight++;return {allowed:true};});
  await queue.runOne({
    db,strictEnabled:()=>true,
    eligibility:async()=>({channel:"whatsapp",whatsapp_number:"60125023908"}),
    sender:async()=>{sends++;return {success:true,wamid:"never"};},
  });
  assert.equal(sends,0);
  assert.equal(preflight,0);
  assert.ok(db.calls.some(x=>x.sql.includes("SET status=$3") &&
    x.params?.includes("outside_customer_service_window")));
});

test("absolute two-minute TTL stops a delayed image before provider call",async()=>{
  const row={...sample(),created_at:new Date(Date.now()-121000).toISOString()};
  const db=fakeDb(row);let sends=0;
  await queue.runOne({
    db,strictEnabled:()=>true,
    eligibility:async()=>{throw Error("expired image must not proceed");},
    sender:async()=>{sends++;},
  });
  assert.equal(sends,0);
  assert.equal(queue.queueExpired(row),true);
  assert.ok(db.calls.some(x=>x.sql.includes("SET status=$3") &&
    x.params?.includes("optional_image_expired_before_send")));
});

test("expiry during image upload cancels before Meta send",async t=>{
  const row=sample(),db=fakeDb(row);
  mock(t,whatsappPolicy,"checkFreeformAllowed",async()=>({allowed:true}));
  mock(t,messagesRepo,"wasMediaRecentlySent",async()=>false);
  mock(t,messagesRepo,"hasUnconfirmedMediaDelivery",async()=>false);
  mock(t,zeroCost,"preflightFreeform",async()=>({allowed:true}));
  mock(t,conversationStore,"appendMessageForContact",async()=>({id:991}));
  mock(t,messagesRepo,"deleteUnsentAssistantMessage",async()=>({id:991}));
  await queue.runOne({db,strictEnabled:()=>true,
    eligibility:async()=>({channel:"whatsapp",whatsapp_number:"60125023908"}),
    sender:async(_contact,_url,_caption,options)=>{
      row.created_at=new Date(Date.now()-121000).toISOString();
      assert.equal(await options.preSendCheck(),false);
      return {success:false,cancelled:true};
    },
  });
  assert.ok(db.calls.some(x=>x.sql.includes("SET status=$3") &&
    x.params?.includes("optional_image_expired_during_upload")));
});

test("stale processing after Render restart is unknown and never blindly replayed",async t=>{
  const contactsRepo=require("../src/db/contactsRepo");
  const staff=[];
  mock(t,contactsRepo,"setDeliveryAttention",async(id,reason)=>{
    staff.push({id,reason});return {id};
  });
  const statements=[];
  const db={async query(sql,params){
    statements.push({sql,params});
    if(sql.includes("RETURNING contact_id,inbound_message_id"))
      return {rows:[{contact_id:443,inbound_message_id:1503}]};
    if(sql.includes("RETURNING q.inbound_message_id"))
      return {rows:[{inbound_message_id:1503}]};
    return {rows:[]};
  }};
  await queue.sweepStaleAndBlocked(db);
  assert.ok(statements.some(x=>x.sql.includes("status='unknown'") &&
    x.sql.includes("worker_interrupted_provider_outcome_unknown")));
  assert.ok(statements.some(x=>x.sql.includes("status='cancelled'") &&
    x.sql.includes("earlier_image_not_sent")));
  assert.equal(staff.length,1);
  assert.equal(staff[0].id,443);
});

test("priority query yields only for unaccepted recent inbound text jobs",async t=>{
  const row=sample(),db=fakeDb(row);
  const original=db.query.bind(db);
  db.query=async(sql,params)=>{
    if(sql.includes("FROM inbound_processing_jobs j")){
      assert.match(sql,/a\.outcome='accepted'/);
      assert.match(sql,/interval '45 seconds'/);
      return {rows:[{busy:false}]};
    }
    return original(sql,params);
  };
  mock(t,whatsappPolicy,"checkFreeformAllowed",async()=>({allowed:true}));
  mock(t,messagesRepo,"wasMediaRecentlySent",async()=>false);
  mock(t,messagesRepo,"hasUnconfirmedMediaDelivery",async()=>false);
  mock(t,zeroCost,"preflightFreeform",async()=>({allowed:true}));
  mock(t,conversationStore,"appendMessageForContact",async()=>({id:998}));
  mock(t,messagesRepo,"setWhatsappMessageId",async()=>({id:998}));
  let sends=0;
  await queue.runOne({
    db,strictEnabled:()=>true,
    eligibility:async()=>({channel:"whatsapp",whatsapp_number:"60125023908"}),
    sender:async()=>{sends++;return {success:true,wamid:"wamid.speed"};},
  });
  assert.equal(sends,1,"a finished reply does not hold the image queue");
});
