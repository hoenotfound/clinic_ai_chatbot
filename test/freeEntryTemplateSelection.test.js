const test = require("node:test");
const assert = require("node:assert/strict");
const {
  selectTemplateSpec, validateTemplateRules, buildStaticMarketingTemplate, validMediaUrl,
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
