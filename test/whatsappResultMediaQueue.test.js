const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zeroCost = require("../src/services/whatsappZeroCostGuard");
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
  mock(t,messagesRepo,"wasMediaRecentlySent",async()=>false);
  mock(t,messagesRepo,"hasUnconfirmedMediaDelivery",async()=>false);
  mock(t,zeroCost,"preflightTemplate",async()=>({
    allowed:false,code:"zero_cost_previous_send_unreconciled",
  }));
  let sent = 0;
  await queue.runOne({
    db,eligibility:async()=>({channel:"whatsapp",whatsapp_number:"60125023908"}),
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
  mock(t,messagesRepo,"wasMediaRecentlySent",async()=>false);
  mock(t,messagesRepo,"hasUnconfirmedMediaDelivery",async()=>false);
  mock(t,zeroCost,"preflightTemplate",async()=>({allowed:true}));
  mock(t,conversationStore,"appendMessageForContact",async()=>({id:991}));
  let persisted = null;
  mock(t,messagesRepo,"setWhatsappMessageId",async(id,wamid)=>{persisted={id,wamid};});
  let sendCount = 0;
  await queue.runOne({
    db,eligibility:async()=>({channel:"whatsapp",whatsapp_number:"60125023908"}),
    sender:async(_contact,_url,_caption,opts)=>{
      sendCount++;
      assert.equal(opts.currentMessageId,991);
      return {success:true,wamid:"wamid.verified"};
    },
  });
  assert.equal(sendCount,1);
  assert.deepEqual(persisted,{id:991,wamid:"wamid.verified"});
  assert.equal(db.calls.some(x=>x.sql.includes("SET status=$3") && x.params?.includes("sent")),true);
  assert.equal(db.calls.some(x=>x.sql.includes("result_images_sent=GREATEST")),true);
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
