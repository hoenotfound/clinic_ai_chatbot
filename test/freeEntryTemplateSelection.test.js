const test = require("node:test");
const assert = require("node:assert/strict");
const {
  selectTemplateSpec, validateTemplateRules, buildStaticMarketingTemplate, validMediaUrl,
  validateApprovedMedia, enrichAutomatedTemplateSpec, prepareAutoPromotionMedia,
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
  const scoped=(media)=>({serviceName:"骨盆调理",identifiedTreatment:"骨盆调理",...media});
  const store={
    isSharedFollowUpConfigKey:(key)=>key.startsWith("messages/follow-up-config/"),
    getSharedFollowUpMediaInfo:async()=>({bytes:4*1024*1024,mimeType:"image/jpeg"}),
  };
  assert.equal(await validateApprovedMedia(format("IMAGE"),
    scoped({mediaKey:"messages/follow-up-config/p.jpg"}), {mediaStore:store}),true);
  assert.equal(await validateApprovedMedia(format("VIDEO"),
    scoped({mediaKey:"messages/follow-up-config/p.jpg"}), {mediaStore:store}),false);
  assert.equal(await validateApprovedMedia(format("IMAGE"),
    scoped({mediaKey:"messages/follow-up-config/p.mp4"}), {mediaStore:store}),false);
  assert.equal(await validateApprovedMedia(format("VIDEO"),
    scoped({mediaKey:"messages/follow-up-config/p.mp4"}), {mediaStore:{
      ...store,getSharedFollowUpMediaInfo:async()=>({bytes:19*1024*1024,mimeType:"video/mp4"}),
    }}),false);
  assert.equal(await validateApprovedMedia(format("VIDEO"),
    scoped({mediaKey:"messages/follow-up-config/p.mp4"}), {mediaStore:{
      ...store,getSharedFollowUpMediaInfo:async()=>({bytes:4*1024*1024,mimeType:"video/mp4"}),
    }}),false, "unverified video codec must fail closed");
  assert.equal(await validateApprovedMedia(format("VIDEO"),
    scoped({mediaKey:"messages/follow-up-config/p.mp4",videoCodecVerified:true}), {mediaStore:{
      ...store,getSharedFollowUpMediaInfo:async()=>({bytes:4*1024*1024,mimeType:"video/mp4"}),
    }}),true);
  const remote="https://cdn.example.com/image.jpg";
  const fetchStub=async (_url,opts)=>{
    assert.equal(opts.method,"HEAD");
    assert.equal(opts.redirect,"error");
    return {ok:true,headers:new Map([["content-type","image/jpeg"],["content-length","4000"]])};
  };
  assert.equal(await validateApprovedMedia(format("IMAGE"),scoped({mediaUrl:remote}),
    {fetchImpl:fetchStub,env:{WHATSAPP_FEP_MEDIA_ALLOWED_HOSTS:""}}),false);
  assert.equal(await validateApprovedMedia(format("IMAGE"),scoped({mediaUrl:remote}),
    {fetchImpl:fetchStub,env:{WHATSAPP_FEP_MEDIA_ALLOWED_HOSTS:"cdn.example.com"}}),true);
});


function currentClinicPromos() {
  return {
    services: ["骨盆调理", "3D 小颜术", "9D 逆龄抗衰", "3D + 9D 组合"].map(name=>({name})),
    promotions: [
      {name:"3D First Trial",linkedService:"3D 小颜术",validFrom:"2026-10-01",validUntil:"2026-10-31",imageUrl:"https://clinic.test/promo-images/32"},
      {name:"9D First Trial",linkedService:"9D 逆龄抗衰",validFrom:"2026-10-01",validUntil:"2026-10-31",imageUrl:"https://clinic.test/promo-images/21",caption:"免费赠送 1 小时经络按摩"},
      {name:"3D + 9D Trial",linkedService:"3D + 9D 组合",validFrom:"2026-10-01",validUntil:"2026-10-31",imageUrl:"https://clinic.test/promo-images/22",caption:"免费赠送 1 小时经络按摩"},
      {name:"Pelvis Packages",linkedService:"骨盆调理",validFrom:"2026-10-01",validUntil:"2026-10-31",packages:[
        {name:"Package A",title:"尊享护理配套｜2小时30分钟",
          aliases:["A套餐","A配套","RM488配套","488配套"],
          followUpImageUrl:"https://clinic.test/promo-images/28"},
        {name:"Package B",title:"1小时30分钟女性护理配套",
          aliases:["B套餐","B配套","RM288配套","288配套","女性护理配套"],
          followUpImageUrl:"https://clinic.test/promo-images/29"},
      ]},
    ],
  };
}
function approvedTemplate(name,format="TEXT",language="zh_CN",bodyVariable=true) {
  return whatsapp.normalizeTemplate({
    name,language,category:"MARKETING",status:"APPROVED",components:[
      ...(format==="TEXT"?[]:[{type:"HEADER",format}]),
      {type:"BODY",text:bodyVariable?"谢谢你了解 {{1}} 的护理，欢迎回复我们": "欢迎回复我们"},
    ],
  });
}
function chosenSpec(name,service,language="zh_CN",messages=[]) {
  return { templateName:name, language,mediaKey:"",mediaUrl:"",
    identifiedTreatment:service,recentInboundMessages:messages };
}
test("approved service check-in fills treatment name without AI substitution",()=>{
  const cfg=currentClinicPromos();
  const template=approvedTemplate("ns_fu1_service_checkin");
  const spec=enrichAutomatedTemplateSpec(chosenSpec(template.name,"3D + 9D 组合"),template,{config:cfg,now:"2026-10-09"});
  assert.equal(spec.bodyValue,"3D + 9D 组合");
  const built=buildStaticMarketingTemplate(template,spec,whatsapp);
  assert.ok(built);
  assert.deepEqual(built.values,{header:[],body:["3D + 9D 组合"]});
  assert.equal(built.components[0].type,"body");
  assert.deepEqual(built.components[0].parameters,[{type:"text",text:"3D + 9D 组合"}]);
  assert.match(built.preview,/3D \+ 9D 组合/);
  const enTemplate=approvedTemplate(template.name,"TEXT","en_US");
  assert.equal(enrichAutomatedTemplateSpec(chosenSpec(enTemplate.name,"9D 逆龄抗衰","en_US"),
    enTemplate,{config:cfg}).bodyValue,"9D Anti-Ageing");
  assert.equal(enrichAutomatedTemplateSpec(chosenSpec(template.name,"Unknown Service"),
    template,{config:cfg}),null);
});
test("pricing graphic chooses exactly one configured active image and correct approved variable",()=>{
  const cfg=currentClinicPromos();
  const template=approvedTemplate("ns_fu_pricing_graphic","IMAGE");
  const spec=enrichAutomatedTemplateSpec(chosenSpec(template.name,"3D 小颜术"),template,
    {config:cfg,now:"2026-10-09T10:00:00+08:00"});
  assert.equal(spec.autoPromoImageId,32);
  assert.equal(spec.bodyValue,"3D 小颜术");
  const preflight=buildStaticMarketingTemplate(template,spec,whatsapp,{allowUnuploadedMedia:true});
  assert.ok(preflight);
  assert.equal(preflight.components.some(p=>p.type==="header"),false);
  assert.equal(buildStaticMarketingTemplate(template,spec,whatsapp),null,"cannot send without actual uploaded media ID");
  const built=buildStaticMarketingTemplate(template,spec,whatsapp,{mediaId:"123456"});
  assert.equal(built.components[0].parameters[0].image.id,"123456");
  assert.equal(built.components[1].parameters[0].text,"3D 小颜术");
  assert.equal(enrichAutomatedTemplateSpec(chosenSpec(template.name,"3D 小颜术"),
    template,{config:cfg,now:"2026-11-01T10:00:00+08:00"}),null,
    "expired promo cannot be used");
});
test("pelvis package needs unambiguous package choice and never selects a single guessed graphic",()=>{
  const cfg=currentClinicPromos(),template=approvedTemplate("ns_fu_pricing_graphic","IMAGE");
  const derive=(messages)=>enrichAutomatedTemplateSpec(
    chosenSpec(template.name,"骨盆调理","zh_CN",messages),template,
    {config:cfg,now:"2026-10-09T10:00:00+08:00"});
  assert.equal(derive(["我想了解骨盆调理"]),null);
  assert.equal(derive(["Package A or Package B?"]),null);
  assert.equal(derive(["我要 Package A"]).autoPromoImageId,28);
  assert.equal(derive(["我想了解 Package B"]).autoPromoImageId,29);
  assert.equal(derive(["我要 Package A"]).bodyValue,"骨盆调理 Package A");
  for (const text of ["我要A配套","我想了解A套餐","RM488配套可以吗","488配套还有吗","尊享护理配套"]) {
    assert.equal(derive([text])?.autoPromoImageId,28,text);
  }
  for (const text of ["我要B配套","B套餐多少钱","RM288配套","288配套","女性护理配套"]) {
    assert.equal(derive([text])?.autoPromoImageId,29,text);
  }
  for (const text of ["A配套还是B配套？","Package A or B?","Package B or Package A?",
     "我想比较A套餐和B套餐","Package A and B","我想了解骨盆调理","A和B哪个好？"]) {
    assert.equal(derive([text]),null,text);
  }
  assert.equal(derive(["我要A配套","我也看看B套餐"]),null,
    "conflicting messages must not guess a package");
  const missingAliases = currentClinicPromos();
  missingAliases.promotions[3].packages[0].aliases=[];
  assert.equal(enrichAutomatedTemplateSpec(chosenSpec(template.name,"骨盆调理",
      "zh_CN",["我要A配套"]),template,
      {config:missingAliases,now:"2026-10-09T10:00:00+08:00"}),null,
    "configured aliases, not hardcoded marketing guesses, control selection");
});
test("free meridian template never attaches a non-gift promotion",()=>{
  const cfg=currentClinicPromos(),template=approvedTemplate("ns_fu_meridian_gift","IMAGE");
  const pick=(service)=>enrichAutomatedTemplateSpec(chosenSpec(template.name,service),template,
    {config:cfg,now:"2026-10-09"});
  assert.equal(pick("3D 小颜术"),null);
  assert.equal(pick("骨盆调理"),null);
  assert.equal(pick("9D 逆龄抗衰").autoPromoImageId,21);
  assert.equal(pick("3D + 9D 组合").autoPromoImageId,22);
});
test("unapproved variables, wrong media, empty label or arbitrary dynamic media are rejected",()=>{
  const cfg=currentClinicPromos();
  const template=approvedTemplate("ns_fu1_service_checkin");
  assert.equal(enrichAutomatedTemplateSpec(chosenSpec("ns_fu1_service_checkin","3D 小颜术",
    "zh_CN",[]),approvedTemplate("random_variable_template"),{config:cfg}),null);
  const missing=approvedTemplate("ns_fu1_service_checkin","TEXT","zh_CN",false);
  const spec=enrichAutomatedTemplateSpec(chosenSpec(missing.name,"3D 小颜术"),missing,{config:cfg});
  assert.equal(buildStaticMarketingTemplate(missing,spec,whatsapp),null);
  const wrongHeader=approvedTemplate("ns_fu_pricing_graphic","VIDEO");
  const promoSpec=enrichAutomatedTemplateSpec(chosenSpec(wrongHeader.name,"3D 小颜术"),
    wrongHeader,{config:cfg,now:"2026-10-09"});
  assert.equal(buildStaticMarketingTemplate(wrongHeader,promoSpec,whatsapp,{mediaId:"123"}),null);
  assert.equal(enrichAutomatedTemplateSpec({...chosenSpec(template.name,"3D 小颜术"),
    mediaUrl:"https://malicious.test/a.jpg"},template,{config:cfg}),null);
});
test("auto promotion media is limited to configured public JPEG/PNG assets <=5MiB",async()=>{
  const spec={autoPromoImageId:21,mediaKey:"",mediaUrl:""};
  const base64=Buffer.from([137,80,78,71]).toString("base64");
  const promos={getPublicImage:async id=>id===21?
    {mime_type:"image/png",data:base64}:null};
  const validateImage=async()=>Buffer.from([1,2,3]);
  const prepared=await prepareAutoPromotionMedia(spec,{promos,validateImage});
  assert.equal(prepared.mimeType,"image/png");
  assert.equal(prepared.filename,"follow-up-promotion-21.png");
  assert.equal((await validateApprovedMedia({header:{format:"IMAGE"}},spec,
    {promos,validateImage})),true);
  assert.equal(await prepareAutoPromotionMedia(spec,{
    promos:{getPublicImage:async()=>({mime_type:"application/pdf",data:base64})},
    validateImage}),null);
  assert.equal(await prepareAutoPromotionMedia(spec,{
    promos:{getPublicImage:async()=>({mime_type:"image/png",data:"X".repeat(8e6)})},
    validateImage}),null);
  assert.equal(await validateApprovedMedia({header:{format:"VIDEO"}},spec,
    {promos,validateImage}),false);
});

test("all-treatment day rules enable distinct templates with specific treatment precedence",()=>{
  const cfg={templateName:"ns_fu2_general_checkin",language:"zh_CN",templateRules:[
    {slotHours:26,serviceName:"*",templateName:"ns_fu1_service_checkin"},
    {slotHours:50,serviceName:"*",templateName:"ns_fu_pricing_graphic"},
    {slotHours:50,serviceName:"骨盆调理",templateName:"ns_fu2_general_checkin"},
    {slotHours:98,serviceName:"*",templateName:"ns_fu_meridian_gift"},
  ]};
  assert.equal(validateTemplateRules(cfg.templateRules,[26,50,98],currentClinicPromos().services),true);
  assert.equal(selectTemplateSpec({
    treatment_interest:"9D 逆龄抗衰",recent_inbound_messages:["9D"]
  },26,cfg).templateName,"ns_fu1_service_checkin");
  assert.equal(selectTemplateSpec({
    treatment_interest:"9D 逆龄抗衰",recent_inbound_messages:["9D"]
  },50,cfg).templateName,"ns_fu_pricing_graphic");
  assert.equal(selectTemplateSpec({
    treatment_interest:"骨盆调理",recent_inbound_messages:["骨盆"]
  },50,cfg).templateName,"ns_fu2_general_checkin",
    "individual treatment overrides take precedence");
  assert.equal(validateTemplateRules([
    ...cfg.templateRules,{slotHours:26,serviceName:"*",templateName:"duplicate"}
  ],[26,50,98],currentClinicPromos().services),false);
});
