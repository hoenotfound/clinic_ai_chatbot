const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareConfigUpdatePayload } = require("../src/routes/config");

const old = "2026-10-07T01:00:00.000Z";
const step = (delayMinutes) => ({
  delayMinutes, timingMode:"after_reply", beforeWindowExpiryMinutes:120,
  messageMode:"fixed", aiInstruction:"", message:"Follow up",
  translations:{en:"Follow up",ms:"Susulan",zh:"跟进"},
  imageUrl:"",videoKey:"",videoFilename:"",serviceOverrides:[],
});
function currentConfig({pricingSocial=false, socialActivatedAt=null}={}){
  return {automatedFollowUp:{
    ...step(120),enabled:true,triggerMode:"all",activatedAt:old,
    quietHours:{enabled:true,start:"00:00",end:"07:00"},
    additionalSteps:[step(360),{
      ...step(1200),timingMode:"before_window_expiry",
      beforeWindowExpiryMinutes:240,
    }],
    pricingReminder:{
      enabled:true,activatedAt:old,socialActivatedAt,
      requirePricingInterest:false,sendBothPelvicPackages:true,
      enableSocialChannels:pricingSocial,
    },
  }};
}
function save(requested,current){
  const result=prepareConfigUpdatePayload({automatedFollowUp:requested},current);
  assert.equal(result.ok,true,JSON.stringify(result));
  return result.updates.automatedFollowUp;
}

test("opt into social reminder without invalidating earlier pending WhatsApp pricing",()=>{
  const existing=currentConfig();
  const updated=save({
    ...existing.automatedFollowUp,
    pricingReminder:{...existing.automatedFollowUp.pricingReminder,enableSocialChannels:true},
  },existing);
  assert.equal(updated.activatedAt,old);
  assert.equal(updated.pricingReminder.activatedAt,old);
  assert.ok(Date.parse(updated.pricingReminder.socialActivatedAt)>Date.parse(old));

  const repeated=save(updated,{automatedFollowUp:updated});
  assert.equal(repeated.pricingReminder.activatedAt,old);
  assert.equal(repeated.pricingReminder.socialActivatedAt,updated.pricingReminder.socialActivatedAt);
});

test("turning social off and back on creates only a new social cohort",()=>{
  const active=currentConfig({pricingSocial:true,socialActivatedAt:old});
  const disabled=save({
    ...active.automatedFollowUp,
    pricingReminder:{...active.automatedFollowUp.pricingReminder,enableSocialChannels:false},
  },active);
  assert.equal(disabled.pricingReminder.activatedAt,old);
  assert.equal(disabled.pricingReminder.socialActivatedAt,null);
  const resumed=save({...disabled,
    pricingReminder:{...disabled.pricingReminder,enableSocialChannels:true},
  },{automatedFollowUp:disabled});
  assert.equal(resumed.pricingReminder.activatedAt,old);
  assert.ok(Date.parse(resumed.pricingReminder.socialActivatedAt)>Date.parse(old));
});

test("changing pricing eligibility rules still starts a fresh pricing cohort",()=>{
  const current=currentConfig({pricingSocial:true,socialActivatedAt:old});
  const updated=save({
    ...current.automatedFollowUp,
    pricingReminder:{...current.automatedFollowUp.pricingReminder,requirePricingInterest:true},
  },current);
  assert.notEqual(updated.pricingReminder.activatedAt,old);
  assert.notEqual(updated.pricingReminder.socialActivatedAt,old);
});
