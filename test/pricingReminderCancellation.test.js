const test = require("node:test");
const assert = require("node:assert/strict");
const pricing = require("../src/services/pricingReminderService");
const pricingRepo = require("../src/db/pricingReminderRepo");
const messagesRepo = require("../src/db/messagesRepo");
const contactsRepo = require("../src/db/contactsRepo");
const messaging = require("../src/services/channelMessagingService");
const clinic = require("../src/config/clinicConfig");

test("pre-send database verification error is recorded as cancelled, never provider failed or unknown", async () => {
  const original = {
    claim: pricingRepo.claim,
    discard: pricingRepo.discard,
    setDeliveryStatusById: messagesRepo.setDeliveryStatusById,
    setDeliveryAttention: contactsRepo.setDeliveryAttention,
    sendImageByUrl: messaging.sendImageByUrl,
    automatedFollowUp: clinic.automatedFollowUp,
  };
  const statuses = [];
  const attention = [];
  const discards = [];
  const candidate = { contact_id: 42, whatsapp_number: "60120000000", anchor_id: 5,\n    third_at: new Date(Date.now() - 10 * 60000).toISOString(),\n    inbound_at: new Date(Date.now() - 12 * 3600000).toISOString() };
  const offer = { imageUrl: "https://example.test/promo.png", caption: "RM388" };
  const settings = { activatedAt: "2026-10-08T00:00:00Z", pricingReminder: { activatedAt: "2026-10-08T00:00:00Z" }, triggerMode: "all" };
  try {
    clinic.automatedFollowUp = {quietHours:{enabled:false,start:"00:00",end:"07:00"}};
    pricingRepo.claim = async () => ({ id:101,contact_id:42,delivery_status:null });
    pricingRepo.discard = async (args) => { discards.push(args); return true; };
    messagesRepo.setDeliveryStatusById = async (id,status,error) => {
      statuses.push({ id,status,error });
      return { id,contact_id:42,delivery_status:status,delivery_error:error };
    };
    contactsRepo.setDeliveryAttention = async (id,message) => attention.push({id,message});
    messaging.sendImageByUrl = async () => ({ success:false,cancelled:true,preSendCheckFailed:true });
    await pricing.sendPricingReminder(candidate,offer,settings);
    assert.equal(statuses.length,1);
    assert.equal(statuses[0].status,"cancelled");
    assert.match(statuses[0].error,/not.*sent|nothing was sent/i);
    assert.equal(attention.length,1);
    assert.match(attention[0].message,/not sent|no WhatsApp.*sent/i);
    assert.equal(discards.length,0);
  } finally {
    pricingRepo.claim = original.claim;
    pricingRepo.discard = original.discard;
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
      {contact_id:42,whatsapp_number:"60120000000",\n        third_at:new Date(Date.now()-10*60000).toISOString(),\n        inbound_at:new Date(Date.now()-12*3600000).toISOString()},
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
