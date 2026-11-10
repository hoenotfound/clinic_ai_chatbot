"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {runWhatsappOutboundRetryQueue}=
  require("../src/services/whatsappOutboundRetryService");

function attempt(extra={}){
  return {
    id:741,message_id:842,contact_id:943,recipient:"60123456789",
    origin:"ai_reply",status:"processing",attempts:1,
    lease_token:"bsuid-retry-test",message_content:"Location?",
    delivery_status:"failed",whatsapp_message_id:null,
    contact_mode:"ai",contact_channel:"whatsapp",
    current_recipient:"60123456789",
    current_user_id:"MY.Safe123",
    current_last_address:"MY.Safe123",
    contact_needs_attention:false,
    has_newer_customer_message:false,has_newer_staff_message:false,
    ...extra,
  };
}
function fixture(row,{latest=row}={}){
  const delivered=[],ops=[];
  return {
    delivered,ops,
    repository:{
      async recoverStaleProcessing(){return [];},
      async claimDue(){return [row];},
      async checkSendEligibility(){return latest;},
      async markSent(id){ops.push(["sent",id]);},
      async markCancelled(id){ops.push(["cancelled",id]);},
      async markFailed(id){ops.push(["failed",id]);},
      async findNextDueAt(){return null;},
    },
    messages:{
      async setWhatsappMessageId(id,wamid){
        return {id,contact_id:943,whatsapp_message_id:wamid,delivery_status:"sent"};
      },
      async setDeliveryStatusById(id,status,error){
        return {id,contact_id:943,delivery_status:status,delivery_error:error};
      },
    },
    contacts:{
      async clearDeliveryAttentionIfNoFailedMessages(){},
      async setDeliveryAttention(){},
    },
    evidence:{async recordOutcome(){}},
    inbound:{async finalizeOutboundAttemptByAssistantMessageId(){}},
    isAutomationEnabled:()=>true,
    async sendMessage(address){delivered.push(address);
      return {success:true,wamid:"wamid.bsuid-retry-success"};},
  };
}
test("retry sends to last provider-verified BSUID, not stored old telephone",async()=>{
  const input=fixture(attempt());
  await runWhatsappOutboundRetryQueue(input);
  assert.deepEqual(input.delivered,["MY.Safe123"]);
  assert.equal(input.ops.some(x=>x[0]==="sent"),true);
});
test("ordinary phone retry remains a phone number",async()=>{
  const input=fixture(attempt({current_user_id:null,
    current_last_address:"60123456789"}));
  await runWhatsappOutboundRetryQueue(input);
  assert.deepEqual(input.delivered,["60123456789"]);
});
test("a BSUID changing between claim and send is never sent to either stale address",async()=>{
  const old=attempt();
  const input=fixture(old,{latest:{...old,current_user_id:"MY.ChangedNow",
    current_last_address:"MY.ChangedNow"}});
  await runWhatsappOutboundRetryQueue(input);
  assert.deepEqual(input.delivered,[]);
});

test("secondary sender retry is cancelled before reaching primary Meta transport",async()=>{
  const row=attempt({
    current_sender_id:15,current_sender_key:"neutro_secondary",
    current_sender_phone_number_id:"1318355951360575",
    current_sender_account_id:"1852014482431209",
    current_sender_state:"active",
  });
  const input=fixture(row);
  await runWhatsappOutboundRetryQueue(input);
  assert.deepEqual(input.delivered,[]);
  assert.equal(input.ops.some(item=>item[0]==="sent"),false);
});

test("primary-scoped retry is sent only for the actual configured sender",async()=>{
  const snapshot={};
  for (const key of ["WHATSAPP_PRIMARY_SENDER_KEY","WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_WABA_ID"]) snapshot[key]=process.env[key];
  Object.assign(process.env,{
    WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
    WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
    WHATSAPP_WABA_ID:"1593376338308612",
  });
  const good=attempt({current_sender_id:12,current_sender_key:"neutro",
    current_sender_phone_number_id:"1408739622311791",
    current_sender_account_id:"1593376338308612",current_sender_state:"active"});
  try {
    const allowed=fixture(good);
    await runWhatsappOutboundRetryQueue(allowed);
    assert.deepEqual(allowed.delivered,["MY.Safe123"]);

    const changed=fixture(good,{latest:{...good,current_sender_key:"neutro_secondary"}});
    await runWhatsappOutboundRetryQueue(changed);
    assert.deepEqual(changed.delivered,[],"sender changed before the final provider call");
  }finally{
    for(const [key,value] of Object.entries(snapshot)){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
});
