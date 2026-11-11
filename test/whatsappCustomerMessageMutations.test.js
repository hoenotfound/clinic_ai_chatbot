"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const whatsapp = require("../src/services/whatsappService");
const mutations = require("../src/services/whatsappCustomerMutationService");

const env = {
  WHATSAPP_WABA_ID: "111111111",
  WHATSAPP_PHONE_NUMBER_ID: "222222222",
  WHATSAPP_SECONDARY_WABA_ID: "333333333",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID: "444444444",
  WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED: "true",
};
function payload(message, secondary = true) {
  return {
    entry: [{
      id: secondary ? env.WHATSAPP_SECONDARY_WABA_ID : env.WHATSAPP_WABA_ID,
      changes: [{
        field: "messages",
        value: {
          metadata: {phone_number_id: secondary ?
            env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID : env.WHATSAPP_PHONE_NUMBER_ID},
          messages: [message],
        },
      }],
    }],
  };
}

test("customer edit is not a new inbound AI turn and preserves corrected text", () => {
  const body = payload({
    id:"wamid.change01", from:"60123456789", type:"edit",
    timestamp:"1794355000",
    edit:{original_message_id:"wamid.original01",
      message:{type:"text",text:{body:"了解价格"}}},
  });
  assert.deepEqual(whatsapp.parseIncomingMessages(body), []);
  const [event] = whatsapp.parseCustomerMessageMutations(body);
  assert.equal(event.action,"edit");
  assert.equal(event.originalMessageId,"wamid.original01");
  assert.equal(event.replacementText,"了解价格");
  assert.equal(event.businessPhoneNumberId,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID);
  assert.equal(mutations.normalize(event,env).action,"edit");
});

test("customer revoke is recognized without creating a ghost inbound message", () => {
  const body = payload({
    id:"wamid.change02", from:"60123456789", type:"revoke",
    revoke:{original_message_id:"wamid.original01"},
  });
  assert.deepEqual(whatsapp.parseIncomingMessages(body), []);
  assert.equal(whatsapp.parseCustomerMessageMutations(body)[0].action,"revoke");
});

test("Meta unsupported(edit) becomes a notice, not a review-triggering inbound", () => {
  const body = payload({
    id:"wamid.change03", from:"60123456789", type:"unsupported",
    unsupported:{type:"edit"},
    errors:[{code:131051,title:"Message type unknown"}],
  },false);
  assert.deepEqual(whatsapp.parseIncomingMessages(body), []);
  const [event] = whatsapp.parseCustomerMessageMutations(body);
  assert.equal(event.action,"unavailable_edit");
  assert.equal(event.replacementText,null);
  assert.equal(event.originalMessageId,null);
  assert.equal(mutations.normalize(event,env).action,"unavailable_edit");
});

test("rejected sender and malformed message IDs cannot mutate existing messages", () => {
  const raw = {
    id:"wamid.change04",originalMessageId:"wamid.original01",
    action:"revoke",from:"60123456789",
    businessAccountId:env.WHATSAPP_SECONDARY_WABA_ID,
    businessPhoneNumberId:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
  };
  assert.equal(mutations.normalize(raw,{...env,WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"false"}),null);
  assert.equal(mutations.normalize({...raw,id:"forged"},env),null);
  assert.equal(mutations.normalize({...raw,originalMessageId:"forged"},env),null);
  assert.equal(mutations.normalize({...raw,businessAccountId:env.WHATSAPP_WABA_ID},env),null);
});

function stubDatabase(action, target = true) {
  const calls = [];
  const event = {
    event_wamid:"wamid.change05", target_wamid:"wamid.original01",
    business_phone_number_id:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
    business_account_id:env.WHATSAPP_SECONDARY_WABA_ID,
    customer_address:"60123456789",customer_user_id:null,
    action, replacement_text:action==="edit"?"Corrected text":null,
    provider_timestamp:1794355000,status:"pending",
  };
  const message = {id:71,contact_id:14,whatsapp_customer_mutation:null,
    whatsapp_customer_mutated_at:null};
  const query = async(sql,args=[]) => {
    calls.push({sql,args});
    if(sql.includes("SELECT * FROM whatsapp_customer_message_mutations")) return {rows:[event]};
    if(sql.includes("SELECT m.id, m.contact_id")) return {rows:target?[message]:[]};
    if(sql.includes("UPDATE messages")) return {rows:[{id:71}]};
    return {rows:[]};
  };
  return {calls,db:{connect:async()=>({query,release(){}}),query}};
}

test("revocation redacts stored content and media, and marks the event applied", async () => {
  const {db,calls} = stubDatabase("revoke");
  const applied = await mutations.applyOne("wamid.change05",{database:db,env});
  assert.equal(applied?.messageId,71);
  const update = calls.find(call=>call.sql.includes("UPDATE messages"));
  assert.equal(update.args[2],mutations.DELETED_TEXT);
  assert.equal(update.args[3],"revoke");
  assert.equal(update.args[5],true);
  assert.match(update.sql,/media_key=CASE WHEN/);
  assert.match(calls.find(call=>call.sql.includes("SELECT m.id")).sql,/m.role = 'user'/);
  assert.ok(calls.some(call=>call.sql.includes("status='applied'")));
});

test("editable text replaces content without deleting a photo attachment", async () => {
  const {db,calls} = stubDatabase("edit");
  await mutations.applyOne("wamid.change05",{database:db,env});
  const update = calls.find(call=>call.sql.includes("UPDATE messages"));
  assert.equal(update.args[2],"Corrected text");
  assert.equal(update.args[3],"edit");
  assert.equal(update.args[5],false);
});

test("unmatched edits remain pending for an out-of-order original", async () => {
  const {db,calls} = stubDatabase("edit",false);
  assert.equal(await mutations.applyOne("wamid.change05",{database:db,env}),null);
  assert.equal(calls.some(call=>call.sql.includes("status='applied'")),false);
  assert.ok(calls.some(call=>call.sql === "COMMIT"));
});

test("a quoted reply context can never identify the edited target", () => {
  const body=payload({
    id:"wamid.change06",from:"60123456789",type:"edit",
    context:{id:"wamid.someoneElsesQuotedMessage"},
    edit:{message:{type:"text",text:{body:"Corrected"}}}
  });
  assert.deepEqual(whatsapp.parseIncomingMessages(body),[]);
  const [event]=whatsapp.parseCustomerMessageMutations(body);
  assert.equal(event.action,"unavailable_edit");
  assert.equal(event.originalMessageId,null);
  assert.equal(event.replacementText,"Corrected");
});

test("a revoke without a verified original ID is never aimed at a quoted message", () => {
  const body=payload({
    id:"wamid.change07",from:"60123456789",type:"revoke",
    context:{id:"wamid.quotedMessage"},
    revoke:{}
  });
  assert.deepEqual(whatsapp.parseCustomerMessageMutations(body),[]);
});

test("unsupported edit notice only updates the event ledger, never messages or AI turns",async()=>{
  const calls=[];
  const database={
    async query(sql,args=[]) {
      calls.push({sql,args});
      if(sql.includes("SELECT c.id")) return {rows:[{id:50}]};
      if(sql.includes("UPDATE whatsapp_customer_message_mutations")) {
        return {rows:[{event_wamid:"wamid.unknown1"}]};
      }
      return {rows:[]};
    }
  };
  const result=await mutations.applyUnavailableNotice({
    id:"wamid.unknown1",target:null,action:"unavailable_edit",
    account:env.WHATSAPP_WABA_ID,phone:env.WHATSAPP_PHONE_NUMBER_ID,
    from:"60123456789",customerUserId:null,timestamp:1794355000
  },{database,env});
  assert.equal(result.contactId,50);
  assert.equal(result.notice,true);
  assert.ok(calls.some(call=>call.sql.includes("notice_contact_id=$2")));
  assert.ok(calls.every(call=>!call.sql.includes("INSERT INTO messages")));
});

test("separate notices read only that contact's ledger rows, newest 30",async()=>{
  const calls=[];
  const notices=await mutations.listNoticesForContact(50,{database:{
    async query(sql,args) {
      calls.push({sql,args});
      return {rows:[{id:"wamid.note1",created_at:new Date("2026-11-11T08:15:00Z")}]};
    }
  }});
  assert.equal(calls[0].args[0],50);
  assert.match(calls[0].sql,/notice_contact_id=\$1/);
  assert.match(calls[0].sql,/LIMIT 30/);
  assert.equal(notices[0].kind,"unavailable_edit");
});

test("startup reconciliation only scans committed original WhatsApp messages",async()=>{
  const calls=[];
  const n=await mutations.reconcilePendingOnStartup({database:{
    async query(sql,args) {calls.push({sql,args});return {rows:[]};},
    async connect(){throw Error("should not open a transaction for an empty sweep")}
  },env});
  assert.equal(n,0);
  assert.match(calls[0].sql,/EXISTS\(SELECT 1 FROM messages/);
  assert.deepEqual(calls[0].args,[40]);
});

test("caption edits retain original media when final download is processed",()=>{
  const fs=require("node:fs");
  const sql=fs.readFileSync(require.resolve("../src/db/messagesRepo"),"utf8");
  assert.match(sql,/SET content = CASE WHEN whatsapp_customer_mutation IS NULL/);
  assert.match(sql,/media_key = \$4, media_mime_type = \$5/);
  assert.match(sql,/whatsapp_customer_mutation IS DISTINCT FROM 'revoke'/);
  assert.match(sql,/async function getMessageUpdatesForContact/);
});
