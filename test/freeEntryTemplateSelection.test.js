const test = require("node:test");
const assert = require("node:assert/strict");
const {
  selectTemplateSpec, validateTemplateRules, buildStaticMarketingTemplate, validMediaUrl,
  validateApprovedMedia,
} = require("../src/utils/freeEntryTemplateSelection");
const whatsapp = require("../src/services/whatsappTemplateService");

const services = [{name:"骨盆调理"}, {name:"3D + 9D"}];

test("service rules include combined 3D + 9D and language follows customer", () => {
  const cfg = {templateName:"ns_enquiry_reengagement", language:"auto", templateRules:[
    {slotHours:50,serviceName:"3D + 9D",templateName:"ns_3d_9d_followup",mediaUrl:""},
  ]};
  assert.equal(validateTemplateRules(cfg.templateRules,[26,50],services),true);
  const selected = selectTemplateSpec({treatment_interest:"3D + 9D",
    recent_inbound_messages:["想了解 3D 和 9D"]},50,cfg);
  assert.equal(selected.templateName,"ns_3d_9d_followup");
  assert.equal(selected.language,"zh_CN");
  assert.equal(selectTemplateSpec({treatment_interest:"骨盆调理",
    recent_inbound_messages:["Hi, interested"]},50,cfg).templateName,"ns_enquiry_reengagement");
});
test("media templates need approved marketing header and explicit https media", () => {
  const valid = {name:"treatment_video",language:"zh_CN",status:"APPROVED",
    category:"MARKETING",header:{format:"VIDEO"},body:{text:"顾客分享"},
    variableFields:[],buttons:[],sendable:false};
  const preview = buildStaticMarketingTemplate(valid,
    {mediaUrl:"https://cdn.example.com/testimonial.mp4"},whatsapp);
  assert.equal(preview.components[0].type,"header");
  assert.equal(preview.components[0].parameters[0].video.link,"https://cdn.example.com/testimonial.mp4");
  assert.equal(buildStaticMarketingTemplate(valid,{mediaUrl:""},whatsapp),null);
  assert.equal(buildStaticMarketingTemplate({...valid,category:"UTILITY"},
    {mediaUrl:"https://cdn.example.com/x.mp4"},whatsapp),null);
  assert.equal(buildStaticMarketingTemplate({...valid,variableFields:[{component:"body",index:1}]},
    {mediaUrl:"https://cdn.example.com/x.mp4"},whatsapp),null);
  assert.equal(validMediaUrl("http://insecure.test/foo"),false);
  assert.equal(validMediaUrl("https://cdn.example.com/x.mp4"),true);
});
test("duplicate service and day rule is not accepted", () => {
  const rule={slotHours:50,serviceName:"骨盆调理",templateName:"pelvis_video",mediaUrl:""};
  assert.equal(validateTemplateRules([rule,{...rule}], [50],services),false);
});

test("a new 3D ad cannot accidentally inherit a previous pelvic treatment", () => {
  const clinicConfig = require("../src/config/clinicConfig");
  const previousServices = clinicConfig.services;
  clinicConfig.services = [
    {name:"骨盆调理"}, {name:"3D 小颜术"}, {name:"9D 逆龄抗衰"},
    {name:"3D + 9D"},
  ];
  try {
  const cfg={templateName:"general",language:"auto",templateRules:[
    {slotHours:50,serviceName:"3D + 9D",templateName:"combo",mediaUrl:""},
    {slotHours:50,serviceName:"骨盆调理",templateName:"pelvis",mediaUrl:""},
    {slotHours:50,serviceName:"3D 小颜术",templateName:"face",mediaUrl:""},
  ]};
  const newAd=selectTemplateSpec({
    treatment_interest:"骨盆调理",lead_started_message_id:10,
    latest_ad_message_id:20,referral_ad_name:"3D 小颜术 treatment",
    recent_inbound_messages:["您好, interested in face"],
  },50,cfg);
  assert.equal(newAd.templateName,"face");
  const customerOverridesAd=selectTemplateSpec({
    treatment_interest:"骨盆调理",lead_started_message_id:10,
    latest_ad_message_id:20,referral_treatment_interest:"3D 小颜术",
    recent_inbound_messages:["我想了解 3D + 9D"],
  },50,cfg);
  assert.equal(customerOverridesAd.templateName,"combo");
  assert.equal(selectTemplateSpec({
    treatment_interest:"骨盆调理",lead_started_message_id:10,
    latest_ad_message_id:20,referral_ad_name:"",
    recent_inbound_messages:["您好"],
  },50,cfg).templateName,"general");
  } finally { clinicConfig.services = previousServices; }
});

test("R2 media and public HTTPS header validation fail closed on MIME and size",async()=>{
  const format=(kind)=>({header:{format:kind}});
  const store={
    isSharedFollowUpConfigKey:(key)=>key.startsWith("messages/follow-up-config/"),
    getSharedFollowUpMediaInfo:async()=>({bytes:4*1024*1024,mimeType:"image/jpeg"}),
  };
  assert.equal(await validateApprovedMedia(format("IMAGE"),
    {mediaKey:"messages/follow-up-config/p.jpg"}, {mediaStore:store}),true);
  assert.equal(await validateApprovedMedia(format("VIDEO"),
    {mediaKey:"messages/follow-up-config/p.jpg"}, {mediaStore:store}),false);
  assert.equal(await validateApprovedMedia(format("IMAGE"),
    {mediaKey:"messages/follow-up-config/p.mp4"}, {mediaStore:store}),false);
  assert.equal(await validateApprovedMedia(format("VIDEO"),
    {mediaKey:"messages/follow-up-config/p.mp4"}, {mediaStore:{
      ...store,getSharedFollowUpMediaInfo:async()=>({bytes:19*1024*1024,mimeType:"video/mp4"}),
    }}),false);
  assert.equal(await validateApprovedMedia(format("VIDEO"),
    {mediaKey:"messages/follow-up-config/p.mp4"}, {mediaStore:{
      ...store,getSharedFollowUpMediaInfo:async()=>({bytes:4*1024*1024,mimeType:"video/mp4"}),
    }}),false, "unverified video codec must fail closed");
  assert.equal(await validateApprovedMedia(format("VIDEO"),
    {mediaKey:"messages/follow-up-config/p.mp4",videoCodecVerified:true}, {mediaStore:{
      ...store,getSharedFollowUpMediaInfo:async()=>({bytes:4*1024*1024,mimeType:"video/mp4"}),
    }}),true);
  const remote="https://cdn.example.com/image.jpg";
  const fetchStub=async (_url,opts)=>{
    assert.equal(opts.method,"HEAD");
    assert.equal(opts.redirect,"error");
    return {ok:true,headers:new Map([["content-type","image/jpeg"],["content-length","4000"]])};
  };
  assert.equal(await validateApprovedMedia(format("IMAGE"),{mediaUrl:remote},
    {fetchImpl:fetchStub,env:{WHATSAPP_FEP_MEDIA_ALLOWED_HOSTS:""}}),false);
  assert.equal(await validateApprovedMedia(format("IMAGE"),{mediaUrl:remote},
    {fetchImpl:fetchStub,env:{WHATSAPP_FEP_MEDIA_ALLOWED_HOSTS:"cdn.example.com"}}),true);
});
