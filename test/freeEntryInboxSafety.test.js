const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {pool}=require("../src/db/db");
const messagesRepo=require("../src/db/messagesRepo");
function source(name){return fs.readFileSync(path.join(__dirname,"../",name),"utf8");}

test("extended marketing templates have explicit automated origin and correct inbox flag", async(t)=>{
 const original=pool.query;
 t.after(()=>{pool.query=original;});
 pool.query=async(sql,params)=>{
  assert.match(sql,/is_automated_follow_up/);
  assert.equal(params.at(-1),true);
  assert.equal(params[4],null,"no synthetic staff username");
  return {rows:[{id:91,contact_id:7,is_automated_follow_up:true}]};
 };
 const result=await messagesRepo.saveMessage(7,"assistant","Approved template",null,null,null,null,null,{
  whatsappTemplate:{name:"ns_enquiry_reengagement",language:"zh_CN",category:"MARKETING"},
  isAutomatedFollowUp:true,
 });
 assert.equal(result.is_automated_follow_up,true);
});

test("extension's unknown template retry is explicitly blocked; staff must use fresh policy-checked send",()=>{
 const route=source("src/routes/conversations.js");
 assert.match(route,/message\.whatsapp_template\?\.automatedFreeEntry === true/);
 assert.match(route,/extended_followup_retry_blocked/);
 const policy=source("src/services/whatsappTemplateService.js");
 assert.match(policy,/expectedOptInAt/);
});

test("cross-lead diagnosis requires both Manage Tools and View all leads",()=>{
 const auth=source("src/middleware/requireAuth.js");
 assert.match(auth,/parts\[1\] === "free-entry-status" && !hasCapability\(user, "view_all_leads"\)/);
 assert.match(auth,/return canTools \? true : forbidden/);
});
