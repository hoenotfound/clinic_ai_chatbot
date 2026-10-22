"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const svc=require("../src/services/whatsappSecondaryTemplateService");
const env={
  WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
  WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
  WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
  WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED:"true",
  WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
  WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
  WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED:"true",
  WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"true",
  WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED:"true",
  WHATSAPP_PHONE_NUMBER_ID:"100000000000001",
  WHATSAPP_WABA_ID:"200000000000001",
  WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
  WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
  WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
  WHATSAPP_SECONDARY_TOKEN:"secret-ariel-provider-token",
  SESSION_SECRET:"test-session-secret-long-enough-1234567890",
};
const contact={
  id:222,channel:"whatsapp",whatsapp_number:"60129990000",
  whatsapp_sender_id:2,whatsapp_sender_key:"ariel",
};
const row={
  id:222,channel:"whatsapp",whatsapp_number:contact.whatsapp_number,
  whatsapp_sender_id:2,whatsapp_opt_in_at:new Date("2026-10-22T08:00:00Z"),
  whatsapp_opt_in_source:"staff-confirmed",
  whatsapp_opt_out_at:null,whatsapp_marketing_opt_out_at:null,
  sender_conversation_id:15,binding_state:"bound",
  customer_wa_id:contact.whatsapp_number,sender_key:"ariel",
  meta_phone_number_id:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
  meta_account_id:env.WHATSAPP_SECONDARY_WABA_ID,
  sender_state:"active",
};
const example={
 id:"meta-template-id",name:"ariel_reply",language:"en_US",
 category:"UTILITY",status:"APPROVED",
 components:[{type:"BODY",text:"Hi {{1}}, thanks for contacting us."}],
};
function fake(overrides={}) {
 const calls=[];
 return {
  calls,
  opts:{
    env,database:{query:async(sql,args)=>{
      calls.push(["sql",sql.slice(0,35),args]);
      return{rows:[row]};
    }},
    fetchImpl:async(url,options)=>{
      calls.push(["meta",String(url),options.headers.Authorization]);
      return{ok:true,json:async()=>({data:[example]})};
    },
    ...overrides,
  },
 };
}
test("Ariel template catalog is fetched with its own token and WABA",async()=>{
 const {opts,calls}=fake();
 const result=await svc.listSecondaryApprovedTemplates(contact,{
  ...opts,staffUsername:"staff-verified",
 });
 assert.equal(result.success,true);
 assert.equal(result.templates.length,1);
 assert.equal(result.templates[0].sendable,true);
 assert.equal(result.billingAdvisory.evidence,"unknown");
 assert.ok(result.billingAdvisory.reviewTokens["ariel_reply::en_US"]);
 const graph=calls.find(c=>c[0]==="meta");
 assert.ok(graph[1].includes(env.WHATSAPP_SECONDARY_WABA_ID));
 assert.equal(graph[2],"Bearer "+env.WHATSAPP_SECONDARY_TOKEN);
 assert.ok(!graph[1].includes(env.WHATSAPP_PHONE_NUMBER_ID));
});
test("Ariel text template values are validated against real approved Meta definition",async()=>{
 const {opts}=fake();
 const prepared=await svc.prepareSecondaryStaffTemplate(contact,{
  name:"ariel_reply",languageCode:"en_US",
  values:{body:["Customer"],header:[]},billingAcknowledged:true,
 },opts);
 assert.equal(prepared.success,true);
 assert.equal(prepared.preview,"Hi Customer, thanks for contacting us.");
 assert.equal(prepared.components[0].type,"body");
 assert.equal(prepared.components[0].parameters[0].text,"Customer");
 assert.match(prepared.signature,/^[a-f0-9]{64}$/);
});
test("sender template policy blocks missing billing acknowledgment and invalid values",async()=>{
 const {opts}=fake();
 for(const [input,code] of [
  [{name:"ariel_reply",languageCode:"en_US",values:{body:["Customer"]}},
    "secondary_template_billing_ack_required"],
  [{name:"ariel_reply",languageCode:"en_US",values:{body:[]},
    billingAcknowledged:true},"secondary_template_invalid_values"],
 ]){
  const result=await svc.prepareSecondaryStaffTemplate(contact,input,opts);
  assert.equal(result.code,code);
 }
});
test("sender template catalog blocks media headers until independently verified",async()=>{
 const image={...example,components:[
  {type:"HEADER",format:"IMAGE"},{type:"BODY",text:"Hi"},
 ]};
 const {opts}=fake({fetchImpl:async()=>({ok:true,json:async()=>({data:[image]})})});
 const result=await svc.listSecondaryApprovedTemplates(contact,{
  ...opts,staffUsername:"staff-verified",
 });
 assert.equal(result.templates.length,1);
 assert.equal(result.templates[0].sendable,false);
 const prepared=await svc.prepareSecondaryStaffTemplate(contact,{
  name:"ariel_reply",languageCode:"en_US",values:{},billingAcknowledged:true,
 },opts);
 assert.equal(prepared.code,"secondary_template_media_not_enabled");
});
test("sender template dispatcher carries exact prepared approval and never falls back to Neutro",async()=>{
 const {opts}=fake();
 const prepared=await svc.prepareSecondaryStaffTemplate(contact,{
  name:"ariel_reply",languageCode:"en_US",
  values:{body:["Customer"]},billingAcknowledged:true,
 },opts);
 let called=false;
 const result=await svc.deliverSecondaryStaffTemplate(contact,456,prepared,{
  ...opts,sendText:async(args,ctx)=>{
    called=true;
    assert.equal(args.messageId,456);
    assert.equal(args.templateRequest.expectedSignature,prepared.signature);
    assert.equal(args.templateRequest.billingConfirmed,true);
    assert.equal(args.origin,"staff");
    const res=await args.dispatchTransport({
      sendTemplatePayload:async(name,lang,components)=>{
        assert.equal(name,"ariel_reply");
        assert.equal(lang,"en_US");
        assert.deepEqual(components,prepared.components);
        return{success:true,wamid:"wamid.sender-template"};
      },
    });
    return res;
  },
 });
 assert.equal(called,true);
 assert.equal(result.wamid,"wamid.sender-template");
});
test("secondary template catalog refuses account mismatch before Meta fetch",async()=>{
 const {opts,calls}=fake();
 const wrong={...contact,whatsapp_sender_key:"neutro"};
 const result=await svc.listSecondaryApprovedTemplates(wrong,opts);
 assert.equal(result.success,false);
 assert.equal(calls.filter(x=>x[0]==="meta").length,0);
});
