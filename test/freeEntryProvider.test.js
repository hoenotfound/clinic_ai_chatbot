const test=require("node:test");
const assert=require("node:assert/strict");
const templates=require("../src/services/whatsappTemplateService");
const policy=require("../src/services/whatsappPolicyService");

test("approved media marketing template send accepts valid provider WAMID and fails safely on timeout",async()=>{
 const original=policy.checkTemplateAllowed;
 const keys=["WHATSAPP_PHONE_NUMBER_ID","WHATSAPP_TOKEN"];
 const env=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 process.env.WHATSAPP_PHONE_NUMBER_ID="test-phone-id";
 process.env.WHATSAPP_TOKEN="test-token";
 policy.checkTemplateAllowed=async()=>({allowed:true,state:{whatsapp_opt_in_at:"2026-10-01T00:00:00Z"}});
 const args={templateName:"ns_followup_video",languageCode:"zh_CN",templateCategory:"MARKETING",
    expectedOptInAt:"2026-10-01T00:00:00Z",
    components:[{type:"header",parameters:[{type:"video",video:{link:"https://example.com/a.mp4"}}]}]};
 try{
   const sent=await templates.sendApprovedTemplate(
     {id:17,channel:"whatsapp",whatsapp_number:"60121234567"},
     {...args,fetchImpl:async (url,init)=>{
       assert.match(url,/test-phone-id\/messages/);
       assert.equal(init.headers.Authorization,"Bearer test-token");
       const body=JSON.parse(init.body);
       assert.equal(body.type,"template");
       assert.equal(body.template.components[0].parameters[0].video.link,"https://example.com/a.mp4");
       return new Response(JSON.stringify({messages:[{id:"wamid.accepted"}]}),{status:200});
     }}
   );
   assert.equal(sent.success,true);
   assert.equal(sent.wamid,"wamid.accepted");
   const ambiguous=await templates.sendApprovedTemplate(
     {id:17,channel:"whatsapp",whatsapp_number:"60121234567"},
     {...args,fetchImpl:async()=>{throw new DOMException("provider timed out","AbortError");}}
   );
   assert.equal(ambiguous.success,false);
   assert.equal(ambiguous.unknown,true);
   policy.checkTemplateAllowed=async()=>({allowed:false,code:"opted_out",message:"Blocked"});
   const blocked=await templates.sendApprovedTemplate(
     {id:17,channel:"whatsapp",whatsapp_number:"60121234567"},
     {...args,fetchImpl:async()=>{throw new Error("must not be called");}}
   );
   assert.equal(blocked.policyBlocked,true);
 }finally{
   policy.checkTemplateAllowed=original;
   for(const key of keys){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}
 }
});
