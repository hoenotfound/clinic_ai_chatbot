const test = require("node:test");
const assert = require("node:assert/strict");
const pricing = require("../src/services/pricingReminderService");
const pricingRepo = require("../src/db/pricingReminderRepo");
const messagesRepo = require("../src/db/messagesRepo");
const contactsRepo = require("../src/db/contactsRepo");
const messaging = require("../src/services/channelMessagingService");
const clinic = require("../src/config/clinicConfig");

test("pre-send database verification error safely discards an unsent claim for later retry", async () => {
  const original = {
    claim: pricingRepo.claim,
    discard: pricingRepo.discard,
    notePreflightFailure: pricingRepo.notePreflightFailure,
    setDeliveryStatusById: messagesRepo.setDeliveryStatusById,
    setDeliveryAttention: contactsRepo.setDeliveryAttention,
    sendImageByUrl: messaging.sendImageByUrl,
    automatedFollowUp: clinic.automatedFollowUp,
  };
  const statuses = [];
  const attention = [];
  const discards = [];
  const retries = [];
  const candidate = { contact_id:42, whatsapp_number:"60120000000", anchor_id:5,
    third_accepted_at:new Date(Date.now()-10*60000).toISOString(),
    inbound_at:new Date(Date.now()-12*3600000).toISOString(),
  };
  const offer = { imageUrl: "https://example.test/promo.png", caption: "RM388", packageName:"Package A" };
  const settings = { activatedAt: "2026-10-08T00:00:00Z", pricingReminder: { activatedAt: "2026-10-08T00:00:00Z" }, triggerMode: "all" };
  try {
    clinic.automatedFollowUp = {quietHours:{enabled:false,start:"00:00",end:"07:00"}};
    pricingRepo.claim = async () => ({ id:101,contact_id:42,delivery_status:null });
    pricingRepo.discard = async (args) => { discards.push(args); return true; };
    pricingRepo.notePreflightFailure = async args => {
      retries.push(args);
      return {attempts:1,retry_after:new Date(Date.now()+30_000).toISOString()};
    };
    messagesRepo.setDeliveryStatusById = async (id,status,error) => {
      statuses.push({ id,status,error });
      return { id,contact_id:42,delivery_status:status,delivery_error:error };
    };
    contactsRepo.setDeliveryAttention = async (id,message) => attention.push({id,message});
    messaging.sendImageByUrl = async () => ({ success:false,cancelled:true,preSendCheckFailed:true });
    await pricing.sendPricingReminder(candidate,offer,settings);
    assert.equal(statuses.length,0);
    assert.equal(attention.length,0,"An unsent transient failure must not block future reminders");
    assert.equal(discards.length,1);
    assert.equal(retries.length,1);
    assert.equal(retries[0].packageKey,"Package A");
  } finally {
    pricingRepo.claim = original.claim;
    pricingRepo.discard = original.discard;
    pricingRepo.notePreflightFailure = original.notePreflightFailure;
    messagesRepo.setDeliveryStatusById = original.setDeliveryStatusById;
    contactsRepo.setDeliveryAttention = original.setDeliveryAttention;
    messaging.sendImageByUrl = original.sendImageByUrl;
    clinic.automatedFollowUp = original.automatedFollowUp;
  }
});

test("a normal pre-send cancellation discards the unsent claim without a provider failure", async()=>{
  const original={
    claim: pricingRepo.claim, discard: pricingRepo.discard,
    setDeliveryStatusById: messagesRepo.setDeliveryStatusById,
    setDeliveryAttention: contactsRepo.setDeliveryAttention,
    sendImageByUrl: messaging.sendImageByUrl,
    automatedFollowUp:clinic.automatedFollowUp,
  };
  let discarded=0;
  let statuses=0;
  try {
    clinic.automatedFollowUp={quietHours:{enabled:false,start:"00:00",end:"07:00"}};
    pricingRepo.claim=async()=>({id:101,contact_id:42});
    pricingRepo.discard=async()=>{discarded++;return true;};
    messagesRepo.setDeliveryStatusById=async()=>{statuses++;return null;};
    contactsRepo.setDeliveryAttention=async()=>{throw Error("Must not mark attention");};
    messaging.sendImageByUrl=async()=>({cancelled:true,success:false});
    await pricing.sendPricingReminder(
      {contact_id:42,whatsapp_number:"60120000000",
        third_accepted_at:new Date(Date.now()-10*60000).toISOString(),
        inbound_at:new Date(Date.now()-12*3600000).toISOString()},
      {imageUrl:"https://example.test/promo.png",caption:"RM388"},
      {activatedAt:"2026-10-08T00:00:00Z",pricingReminder:{activatedAt:"2026-10-08T00:00:00Z"}}
    );
    assert.equal(discarded,1);
    assert.equal(statuses,0);
  } finally {
    pricingRepo.claim=original.claim; pricingRepo.discard=original.discard;
    messagesRepo.setDeliveryStatusById=original.setDeliveryStatusById;
    contactsRepo.setDeliveryAttention=original.setDeliveryAttention;
    messaging.sendImageByUrl=original.sendImageByUrl;
    clinic.automatedFollowUp=original.automatedFollowUp;
  }
});

test("temporary messaging-policy outage is a safe pre-provider retry, not a failed delivery",async()=>{
  const old={
    claim:pricingRepo.claim,discard:pricingRepo.discard,
    note:pricingRepo.notePreflightFailure,
    attention:contactsRepo.setDeliveryAttention,
    status:messagesRepo.setDeliveryStatusById,
    send:messaging.sendImageByUrl,
  };
  const calls={discards:0,retries:0,attention:0,status:0,retryAt:null};
  try {
    pricingRepo.claim=async()=>({id:31,contact_id:42});
    pricingRepo.discard=async()=>{calls.discards++;return true;};
    pricingRepo.notePreflightFailure=async()=>{
      calls.retries++;
      return {attempts:2,retry_after:new Date(Date.now()+60_000).toISOString()};
    };
    contactsRepo.setDeliveryAttention=async()=>{calls.attention++;};
    messagesRepo.setDeliveryStatusById=async()=>{calls.status++;};
    messaging.sendImageByUrl=async()=>({
      success:false,policyBlocked:true,policyCode:"policy_state_unavailable",
      error:"Policy lookup timed out",externalMessageId:null,
    });
    await pricing.sendPricingReminder({
      contact_id:42,channel:"whatsapp",anchor_id:5,whatsapp_number:"60120000000",
      third_accepted_at:new Date(Date.now()-8*60000).toISOString(),
      inbound_at:new Date(Date.now()-10*3600000).toISOString(),
    },{imageUrl:"https://example.test/price.png",caption:"RM388",packageName:"Package A"},
    {activatedAt:"2026-10-08T00:00:00Z",pricingReminder:{activatedAt:"2026-10-08T00:00:00Z"},
      quietHours:{enabled:false,start:"00:00",end:"07:00"},triggerMode:"all"},
    1,at=>{calls.retryAt=at;});
    assert.equal(calls.discards,1);
    assert.equal(calls.retries,1);
    assert.equal(calls.status,0);
    assert.equal(calls.attention,0);
    assert.ok(Date.parse(calls.retryAt)>Date.now());
  } finally {
    pricingRepo.claim=old.claim;pricingRepo.discard=old.discard;
    pricingRepo.notePreflightFailure=old.note;
    contactsRepo.setDeliveryAttention=old.attention;
    messagesRepo.setDeliveryStatusById=old.status;
    messaging.sendImageByUrl=old.send;
  }
});

test("third consecutive confirmed-unsent preflight failure escalates to staff",async()=>{
  const old={
    claim:pricingRepo.claim,discard:pricingRepo.discard,note:pricingRepo.notePreflightFailure,
    send:messaging.sendImageByUrl,attention:contactsRepo.setDeliveryAttention,
  };
  const attention=[];
  try{
    pricingRepo.claim=async()=>({id:31,contact_id:42});
    pricingRepo.discard=async()=>true;
    pricingRepo.notePreflightFailure=async()=>({attempts:3,retry_after:new Date()});
    messaging.sendImageByUrl=async()=>({cancelled:true,preSendCheckFailed:true});
    contactsRepo.setDeliveryAttention=async(_id,reason)=>attention.push(reason);
    await pricing.sendPricingReminder({
      contact_id:42,channel:"whatsapp",anchor_id:5,whatsapp_number:"60120000000",
      third_accepted_at:new Date(Date.now()-8*60000).toISOString(),
      inbound_at:new Date(Date.now()-10*3600000).toISOString(),
    },{imageUrl:"https://example.test/price.png",caption:"RM388",packageName:"Package A"},
    {activatedAt:"2026-10-08T00:00:00Z",pricingReminder:{activatedAt:"2026-10-08T00:00:00Z"},
      quietHours:{enabled:false,start:"00:00",end:"07:00"},triggerMode:"all"});
    assert.equal(attention.length,1);
    assert.match(attention[0],/repeated attempts/i);
  }finally{
    pricingRepo.claim=old.claim;pricingRepo.discard=old.discard;
    pricingRepo.notePreflightFailure=old.note;
    messaging.sendImageByUrl=old.send;contactsRepo.setDeliveryAttention=old.attention;
  }
});
