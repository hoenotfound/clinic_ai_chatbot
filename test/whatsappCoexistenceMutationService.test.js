"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const service=require("../src/services/whatsappCoexistenceMutationService");
const fs=require("node:fs");
const path=require("node:path");
const source=fs.readFileSync(path.join(__dirname,"../src/services/whatsappCoexistenceService.js"),"utf8");
const env={
 WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"110552088553929",
 WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
};
const contact={id:14,whatsapp_number:"60125558888",whatsapp_sender_id:5};
const echo={id:"wamid.edit-2",originalMessageId:"wamid.original-1",
 type:"edit",text:"Updated appointment details"};
function make({found=true,duplicate=false}={}){
 const calls=[];
 const database={
   query:async(sql,args=[])=>{
     calls.push({sql,args});
     if(sql.includes("INSERT INTO whatsapp_sender_coexistence_mutations"))
       return{rows:duplicate?[]:[{id:11,status:"pending"}]};
     if(sql.startsWith("SELECT id,contact_id,target_wamid"))
       return{rows:[{id:11,contact_id:14,target_wamid:echo.originalMessageId,
         action:echo.type,replacement_text:echo.text,status:"applied"}]};
     return{rows:[],rowCount:1};
   },
   connect:async()=>({
     query:async(sql,args=[])=>{
       calls.push({sql,args});
       if(sql===service.LOOKUP_SQL)
         return{rows:found?[{id:11,sender_id:5,contact_id:14,
           target_id:55,action:"edit",replacement_text:echo.text}]:[]};
       if(sql.startsWith("UPDATE messages"))
         return{rows:[{id:55}],rowCount:1};
       return{rows:[],rowCount:1};
     },
     release:()=>{},
   }),
 };
 const conversations={senderForContact:async()=>({
   conversation_id:17,customer_wa_id:contact.whatsapp_number,
   sender_key:"ariel",meta_phone_number_id:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
   meta_account_id:env.WHATSAPP_SECONDARY_WABA_ID,
 })};
 return{database,conversations,calls};
}
test("phone-side edit updates original row and does not produce another assistant message",async()=>{
 const f=make();
 const r=await service.record(echo,contact,{...f,env});
 assert.equal(r.isNew,true);
 assert.equal(r.messageId,55);
 assert.equal(f.calls.filter(x=>x.sql.startsWith("UPDATE messages")).length,1);
 assert.equal(f.calls.some(x=>x.sql.includes("INSERT INTO messages")),false);
 assert.match(source,/\["edit","revoke"\]\.includes\(echo\.type\)/);
 assert.match(source,/isMutation:true/);
});
test("replayed or out-of-order echo mutations never create duplicate messages",async()=>{
 const prior=make({duplicate:true});
 const duplicate=await service.record(echo,contact,{...prior,env});
 assert.equal(duplicate.isNew,false);
 assert.equal(duplicate.alreadySeen,true);
 const delayed=make({found:false});
 const pending=await service.record(echo,contact,{...delayed,env});
 assert.equal(pending.isNew,true);
 assert.equal(pending.pending,true);
 assert.equal(delayed.calls.filter(x=>x.sql.startsWith("UPDATE messages")).length,0);
});
test("Meta-padded WAMIDs are valid for sender-scoped edit and revoke operations",async()=>{
 const f=make();
 const padded={...echo,id:"wamid.HBgLZWRpdA==",originalMessageId:"wamid.HBgL+L29yaWdpbmFs/="};
 const edit=await service.record(padded,contact,{...f,env});
 assert.equal(edit.isNew,true);
 assert.equal(edit.messageId,55);
 assert.equal(f.calls.filter(x=>x.sql.startsWith("UPDATE messages")).length,1);

 const revoke=await service.record({...padded,id:"wamid.HBgLcmV2b2tl=",type:"revoke",text:null},
   contact,{...make(),env});
 assert.equal(revoke.isNew,true);
});

test("invalid IDs and unrenderable edits fail closed without touching messages",async()=>{
 const f=make();
 for(const unsafe of [
   {...echo,id:"wamid.unsafe?"},
   {...echo,originalMessageId:"wamid.bad#target"},
   {...echo,text:null},
   {...echo,text:"  "},
   {...echo,text:"x".repeat(4097)},
 ]) {
   await assert.rejects(service.record(unsafe,contact,{...f,env}),
     /Unsupported WhatsApp Business App/);
 }
 assert.equal(f.calls.length,0);
});

test("malformed, cross-number, and ungrounded mutation targets fail closed",async()=>{
 const f=make();
 await assert.rejects(service.record({...echo,originalMessageId:""},contact,
   {...f,env}),/Unsupported WhatsApp Business App/);
 await assert.rejects(service.record(echo,{...contact,whatsapp_sender_id:999},
   {...f,env: {...env,WHATSAPP_SECONDARY_SENDER_KEY:"wrong"}}),/sender mismatch/);
 assert.equal(f.calls.some(x=>x.sql.includes("INSERT INTO messages")),false);
});
