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
const pricingReminder = {enabled:true,activatedAt,requirePricingInterest:false,sendBothPelvicPackages:false,enableSocialChannels:true};
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
    clinic.promotions=[{name:"3D",linkedService:"3D 小颜术",
      packages:[{name:"3D trial",imageUrl:offer.imageUrl,caption:offer.caption}]}];
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

test("existing clinics stay WhatsApp-only until the social option is enabled",async()=>{
  const original=pricingRepo.listEligible;
  const queried=[];
  try {
    pricingRepo.listEligible=async(options)=>{queried.push(options.channels);return [];};
    await pricing.runPricingReminders({...settings,
      pricingReminder:{...pricingReminder,enableSocialChannels:false}});
    await pricing.runPricingReminders(settings);
    assert.deepEqual(queried,[["whatsapp"],["whatsapp","facebook","instagram"]]);
  } finally {pricingRepo.listEligible=original;}
});

test("a postponed pricing preflight wakes the worker at its durable retry time",async()=>{
  const original={
    listEligible:pricingRepo.listEligible,
    sendImage:messaging.sendImageByUrl,
    promotions:clinic.promotions,services:clinic.services,aliases:clinic.serviceAliases,
  };
  const wakeAt=new Date(Date.now()+75_000);
  let sends=0;
  try{
    clinic.services=[{name:"3D 小颜术"}];
    clinic.serviceAliases=[];
    clinic.promotions=[{name:"3D",linkedService:"3D 小颜术",
      packages:[{name:"Main offer",imageUrl:"https://example.test/price.png",caption:"RM488"}]}];
    pricingRepo.listEligible=async()=>[{
      contact_id:102,channel:"whatsapp",whatsapp_number:"60120000000",
      anchor_id:202,inbound_id:201,third_id:203,
      inbound_at:new Date(Date.now()-10*3600000).toISOString(),
      third_accepted_at:new Date(Date.now()-10*60000).toISOString(),
      due_at:new Date(Date.now()-5*60000).toISOString(),
      preflight_retry_after:wakeAt,preflight_retry_attempts:1,
      treatment_interest:"3D 小颜术",recent_customer_messages:["What is 3D?"],sent_media:[],
    }];
    messaging.sendImageByUrl=async()=>{sends++;throw Error("Must honor backoff before sending");};
    const due=await pricing.runPricingReminders(settings);
    assert.equal(Date.parse(due),Date.parse(wakeAt.toISOString()));
    assert.equal(sends,0);
  }finally{
    pricingRepo.listEligible=original.listEligible;
    messaging.sendImageByUrl=original.sendImage;
    clinic.promotions=original.promotions;clinic.services=original.services;
    clinic.serviceAliases=original.aliases;
  }
});

test("WhatsApp pricing pre-send survives changes to social-only reminder settings", async () => {
  const prior = {
    claim:pricingRepo.claim, check:pricingRepo.isClaimStillEligible,
    send:messaging.sendImageByUrl, waId:messagesRepo.setWhatsappMessageId,
    alias:messagesRepo.socialProviderAliasRecorder,
    cfg:clinic.automatedFollowUp, services:clinic.services,
    promotions:clinic.promotions, aliases:clinic.serviceAliases,
  };
  const candidate={
    channel:"whatsapp",contact_id:91,whatsapp_number:"60123456789",
    anchor_id:105,inbound_id:104,third_id:109,
    third_accepted_at:new Date(Date.now()-9*60000).toISOString(),
    inbound_at:new Date(Date.now()-12*3600000).toISOString(),
    treatment_interest:"3D 小颜术",
    recent_customer_messages:["I want 3D"],sent_media:[],
  };
  const offer={
    serviceName:"3D 小颜术",packageName:"Trial",
    imageUrl:"https://example.test/price.jpg",caption:"RM488",
    identities:["/price.jpg"],
  };
  const originallyOff={
    activatedAt,triggerMode:"all",quietHours,
    steps:[{},{},final],
    pricingReminder:{...pricingReminder,enableSocialChannels:false,
      socialActivatedAt:null},
  };
  try{
    clinic.services=[{name:"3D 小颜术"}];
    clinic.serviceAliases=[];
    clinic.promotions=[{name:"3D",linkedService:"3D 小颜术",packages:[
      {name:offer.packageName,imageUrl:offer.imageUrl,caption:offer.caption},
    ]}];
    pricingRepo.claim=async()=>({id:110,contact_id:91});
    pricingRepo.isClaimStillEligible=async()=>true;
    messagesRepo.socialProviderAliasRecorder=()=>null;
    messagesRepo.setWhatsappMessageId=async()=>({id:110,contact_id:91,delivery_status:"pending"});
    for (const enabledBefore of [false,true]){
      let permitted=null;
      const snapshot={
        ...originallyOff,
        pricingReminder:{...originallyOff.pricingReminder,
          enableSocialChannels:enabledBefore,
          socialActivatedAt:enabledBefore?activatedAt:null},
      };
      clinic.automatedFollowUp={
        enabled:true,activatedAt,triggerMode:"all",quietHours,
        additionalSteps:[{},final],
        pricingReminder:{...snapshot.pricingReminder,
          enableSocialChannels:!enabledBefore,
          socialActivatedAt:enabledBefore?null:new Date().toISOString()},
      };
      messaging.sendImageByUrl=async(_contact,_url,_caption,options)=>{
        permitted=await options.preSendCheck();
        return permitted ? {success:true,wamid:"wamid.pricing"} : {success:false,cancelled:true};
      };
      const sent=await pricing.sendPricingReminder(candidate,offer,snapshot);
      assert.equal(permitted,true,
        "A social-only setting toggle must not cancel an existing WhatsApp price send");
      assert.equal(sent,true);
    }
  }finally{
    pricingRepo.claim=prior.claim;pricingRepo.isClaimStillEligible=prior.check;
    messaging.sendImageByUrl=prior.send;messagesRepo.setWhatsappMessageId=prior.waId;
    messagesRepo.socialProviderAliasRecorder=prior.alias;
    clinic.automatedFollowUp=prior.cfg;clinic.services=prior.services;
    clinic.promotions=prior.promotions;clinic.serviceAliases=prior.aliases;
  }
});
