"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const repo = require("../src/db/whatsappSenderConversationRepo");

const identity = {
  accountId: "200000000000002",
  phoneNumberId: "110552088553929",
  customerPhone: "+60 13-555 0000",
};

test("Business App mutation contact lookup reads only a bound sender-owned conversation", async () => {
  const queries = [];
  const database = {
    query: async (sql, args) => {
      queries.push({sql,args});
      return {rows:[{
        id:14,whatsapp_number:"60135550000",
        whatsapp_sender_id:5,whatsapp_sender_key:"ariel",
        whatsapp_sender_conversation_id:17,
      }]};
    },
  };
  const contact=await repo.findBoundContactForSender(identity,database);
  assert.equal(contact.id,14);
  assert.equal(contact.whatsapp_sender_conversation_id,17);
  assert.equal(queries.length,1);
  assert.match(queries[0].sql,/^SELECT c\.\*/);
  assert.match(queries[0].sql,/sa\.state='active'/);
  assert.match(queries[0].sql,/sc\.state='bound'/);
  assert.match(queries[0].sql,/c\.whatsapp_sender_id=sc\.sender_id/);
  assert.match(queries[0].sql,/c\.whatsapp_number=sc\.customer_wa_id/);
  assert.deepEqual(queries[0].args,[
    "200000000000002","110552088553929","60135550000",
  ]);
  assert.equal(queries.some(q=>/\b(?:INSERT|UPDATE|DELETE)\b/i.test(q.sql)),false);
});

test("no sender-bound contact means no mutation target and no contact creation", async () => {
  const queries=[];
  const database={
    query:async(sql,args)=>{
      queries.push({sql,args});
      return{rows:[]};
    },
  };
  assert.equal(await repo.findBoundContactForSender(identity,database),null);
  assert.equal(queries.length,1);
  assert.match(queries[0].sql,/^SELECT /);
});

test("invalid mutation sender and customer IDs are rejected before the lookup", async () => {
  let queries=0;
  const database={query:async()=>{queries++;throw Error("should never query");}};
  for (const bad of [
    {...identity,accountId:"other_account"},
    {...identity,phoneNumberId:"phone-A"},
    {...identity,customerPhone:"not-a-phone"},
  ]) {
    await assert.rejects(repo.findBoundContactForSender(bad,database));
  }
  assert.equal(queries,0);
});
