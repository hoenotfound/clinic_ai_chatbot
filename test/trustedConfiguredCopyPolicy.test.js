"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {
  hasUnsafeClinicalPromotionCopy, configuredPromotionCopyBlocked,
  isPromotionManuallyPaused,
}=require("../src/utils/promotionClinicalCopyPolicy");
const { followUpCopyViolation }=require("../src/services/followUpAiService");

test("per-clinic trust never defeats manually paused promotions or nested packages",()=>{
  const unsafe={ name:"9D",caption:"Restore 90% of collagen",
    packages:[{name:"Main",caption:"No side effects"}]};
  assert.equal(hasUnsafeClinicalPromotionCopy(unsafe.caption),true);
  assert.equal(configuredPromotionCopyBlocked(unsafe),true,"non-opt-in clinics remain protected");
  assert.equal(configuredPromotionCopyBlocked(unsafe,false),true);
  assert.equal(configuredPromotionCopyBlocked(unsafe,true),false,"explicitly trusted configured copy may send");
  const parentPaused={...unsafe,automaticMediaHold:true};
  assert.equal(isPromotionManuallyPaused(parentPaused),true);
  assert.equal(configuredPromotionCopyBlocked(parentPaused,true),true);
  const childPaused={...unsafe,packages:[{...unsafe.packages[0],automaticMediaHold:true}]};
  assert.equal(isPromotionManuallyPaused(childPaused),true);
  assert.equal(configuredPromotionCopyBlocked(childPaused,true),true);
  assert.equal(configuredPromotionCopyBlocked({caption:"Ordinary appointment invitation"},true),false);
});

test("fixed or approved voice scheduling reminders skip repeat only, not copy filtering, when clinic opts in",()=>{
  const text="做完没有恢复期哦。你这周哪天方便过来？";
  const history=[{role:"user",content:"9D 想了解"},
    {role:"assistant",content:"这是有关9D的资料"},
  ];
  assert.equal(followUpCopyViolation(text,history),"unsafe_clinical_promise");
  assert.equal(followUpCopyViolation(text,history,{checkClinicalCopy:false}),null);
  const alreadyAsked=[{role:"user",content:"想了解9D"},
    {role:"assistant",content:"这周哪天方便过来呢？",delivery_status:"sent"}];
  assert.equal(followUpCopyViolation(text,alreadyAsked,{checkClinicalCopy:false}),"repeated_scheduling_nudge");
  assert.equal(followUpCopyViolation(text,alreadyAsked),"unsafe_clinical_promise");
});
