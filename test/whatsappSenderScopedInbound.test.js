"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createInboundMessageClaimService } = require("../src/services/inboundMessageClaimService");

function make({ duplicate = false, associate = true, found = true } = {}) {
  const calls = [];
  const client = {
    async query(sql) {
      const op = sql.startsWith("SELECT") ? "SELECT" : sql;
      calls.push(op);
      if (sql.startsWith("SELECT")) return {rows: found ? [{id:91}] : []};
      return {rows:[]};
    },
    release(){calls.push("release");}
  };
  const database={async connect(){calls.push("connect");return client;}};
  const processing = {
    async storeInboundClaim({contactId}, queryable) {
      calls.push("save");
      assert.equal(queryable,client);
      if(duplicate)return null;
      return {
        savedInbound:{id:91,contact_id:contactId},
        processingJob:{id:95,message_id:91},
        derivedFirstMessage:true
      };
    }
  };
  const senderIdentity={
    async claimSenderContact(){calls.push("claim-sender");return {
      id:17,channel:"whatsapp",whatsapp_sender_key:"neutro",
      whatsapp_sender_conversation_id:7
    };},
    async attachMessageContext({messageId,contactId,conversationId},queryable){
      calls.push("link");
      assert.deepEqual([messageId,contactId,conversationId],[91,17,7]);
      assert.equal(queryable,client);
      return associate?{message_id:91,conversation_id:7}:null;
    }
  };
  const service=createInboundMessageClaimService({
    database,processing,senderIdentity,
    events:{publish:()=>{calls.push("publish");}}
  });
  return{calls,service};
}
async function withFlag(t){
  const old=process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED;
  process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED="true";
  t.after(()=>{if(old===undefined)delete process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED;
    else process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED=old;});
}
const incoming={id:"wamid-1",from:"60123001234",channel:"whatsapp",text:"hello",
 businessPhoneNumberId:"1408739622311791",businessAccountId:"200000000000001"};

test("scoped inbound commits saved message and context together",async t=>{
 await withFlag(t);
 const {calls,service}=make();
 const r=await service.storeIncomingMessage(incoming);
 assert.equal(r.savedInbound.id,91);
 assert.deepEqual(calls,["claim-sender","connect","BEGIN","save","link","COMMIT","release","publish"]);
});
test("a duplicate callback verifies its original sender mapping",async t=>{
 await withFlag(t);
 const {calls,service}=make({duplicate:true});
 assert.equal(await service.storeIncomingMessage(incoming),null);
 assert.deepEqual(calls,["claim-sender","connect","BEGIN","save","SELECT","link","COMMIT","release"]);
});
test("failed association rolls back the message and requests webhook retry",async t=>{
 await withFlag(t);
 const {calls,service}=make({associate:false});
 await assert.rejects(service.storeIncomingMessage(incoming),/inconsistent/);
 assert.deepEqual(calls,["claim-sender","connect","BEGIN","save","link","ROLLBACK","release"]);
});
test("duplicate WAMID with wrong sender contact fails closed",async t=>{
 await withFlag(t);
 const {calls,service}=make({duplicate:true,found:false});
 await assert.rejects(service.storeIncomingMessage(incoming),/cannot be matched/);
 assert.ok(calls.includes("ROLLBACK"));
 assert.ok(!calls.includes("link"));
});
