const test = require("node:test");
const assert = require("node:assert/strict");
const pricing = require("../src/services/pricingReminderService");
const pricingRepo = require("../src/db/pricingReminderRepo");
const messagesRepo = require("../src/db/messagesRepo");
const contactsRepo = require("../src/db/contactsRepo");
const messaging = require("../src/services/channelMessagingService");
const clinic = require("../src/config/clinicConfig");

const activatedAt = "2026-10-08T00:00:00Z";
const quietHours = {enabled:false,start:"00:00",end:"07:00"};
const final = {delayMinutes:1200,beforeWindowExpiryMinutes:240,timingMode:"before_window_expiry"};
const pricingReminder = {enabled:true,activatedAt,requirePricingInterest:false,sendBothPelvicPackages:false};
const settings = {
  activatedAt,triggerMode:"all",quietHours,
  steps:[{},{},final],pricingReminder,
};

async function withSocialFixtures(channel, deliveredResult) {
  const original = {
    claim:pricingRepo.claim,
    check:pricingRepo.isClaimStillEligible,
    socialAlias:messagesRepo.socialProviderAliasRecorder,
    socialId:messagesRepo.setSocialProviderMessageId,
    status:messagesRepo.setDeliveryStatusById,
    attention:contactsRepo.setDeliveryAttention,
    send:messaging.sendImageByUrl,
    cfg:clinic.automatedFollowUp,services:clinic.services,
    promotions:clinic.promotions,aliases:clinic.serviceAliases,
  };
  const calls={sent:[],aliases:[],receipts:[],statuses:[],attention:[]};
  const candidate={
    contact_id:41,channel,channel_user_id:"scoped-person",
    whatsapp_number:null,anchor_id:12,inbound_id:11,third_id:15,
    third_accepted_at:new Date(Date.now()-10*60000).toISOString(),
    inbound_at:new Date(Date.now()-12*3600000).toISOString(),
    treatment_interest:"3D 小颜术",
    recent_customer_messages:["What does 3D do?"],
    sent_media:[],
  };
  const offer={
    serviceName:"3D 小颜术",promotionName:"3D",packageName:"3D trial",
    imageUrl:"https://example.test/promo-images/32",caption:"RM488",identities:["/promo-images/32"],
  };
  try {
    clinic.automatedFollowUp={
      enabled:true,activatedAt,triggerMode:"all",quietHours,
      additionalSteps:[{},final],pricingReminder,
    };
    clinic.services=[{name:"3D 小颜术"}];
    clinic.serviceAliases=[];
    clinic.promotions=[{name:"3D",linkedService:"3D 小颜术",imageUrl:offer.imageUrl,caption:offer.caption}];
    pricingRepo.claim=async()=>({id:77,contact_id:41});
    pricingRepo.isClaimStillEligible=async()=>true;
    messagesRepo.socialProviderAliasRecorder=(id,aliasChannel)=>{
      assert.equal(id,77);
      assert.equal(aliasChannel,channel);
      return async(mid)=>{calls.aliases.push(mid);};
    };
    messagesRepo.setSocialProviderMessageId=async(id,mid,status)=>{
      calls.receipts.push({id,mid,status});
      return {id,contact_id:41,delivery_status:status,whatsapp_message_id:mid};
    };
    messagesRepo.setDeliveryStatusById=async(id,status,error)=>{
      calls.statuses.push({id,status,error});
      return {id,contact_id:41,delivery_status:status,delivery_error:error};
    };
    contactsRepo.setDeliveryAttention=async(id,reason)=>calls.attention.push({id,reason});
    messaging.sendImageByUrl=async(contact,url,caption,options)=>{
      calls.sent.push({contact,url,caption,purpose:options.purpose});
      assert.equal(await options.preSendCheck(),true);
      if(options.onProviderMessageId) await options.onProviderMessageId("mid.caption");
      if (deliveredResult.success && options.onProviderMessageId) await options.onProviderMessageId("mid.image");
      return deliveredResult;
    };
    calls.success=await pricing.sendPricingReminder(candidate,offer,settings);
  } finally {
    pricingRepo.claim=original.claim;
    pricingRepo.isClaimStillEligible=original.check;
    messagesRepo.socialProviderAliasRecorder=original.socialAlias;
    messagesRepo.setSocialProviderMessageId=original.socialId;
    messagesRepo.setDeliveryStatusById=original.status;
    contactsRepo.setDeliveryAttention=original.attention;
    messaging.sendImageByUrl=original.send;
    clinic.automatedFollowUp=original.cfg;
    clinic.services=original.services;
    clinic.promotions=original.promotions;
    clinic.serviceAliases=original.aliases;
  }
  return calls;
}

for (const channel of ["facebook","instagram"]) {
  test(`${channel}: accepted caption+image yields one pricing receipt`,async()=>{
    const result=await withSocialFixtures(channel,{success:true,externalMessageId:"mid.image"});
    assert.equal(result.success,true);
    assert.equal(result.sent.length,1);
    assert.equal(result.sent[0].contact.channel,channel);
    assert.equal(result.sent[0].contact.channel_user_id,"scoped-person");
    assert.equal(result.sent[0].purpose,"marketing");
    assert.equal(result.sent[0].caption,"RM488");
    assert.deepEqual(result.aliases,["mid.caption","mid.image"]);
    assert.deepEqual(result.receipts,[{id:77,mid:`${channel}:mid.image`,status:"sent"}]);
    assert.deepEqual(result.statuses,[]);
    assert.deepEqual(result.attention,[]);
  });
  test(`${channel}: accepted caption with failed image remains unknown and needs review`,async()=>{
    const result=await withSocialFixtures(channel,{
      success:false,partialCaptionSent:true,captionProviderMessageId:"mid.caption",
      error:"Image upload rejected",
    });
    assert.equal(result.success,false);
    assert.deepEqual(result.aliases,["mid.caption"]);
    assert.equal(result.receipts.length,0);
    assert.equal(result.statuses[0].status,"unknown");
    assert.match(result.attention[0].reason,/unconfirmed/i);
  });
}
