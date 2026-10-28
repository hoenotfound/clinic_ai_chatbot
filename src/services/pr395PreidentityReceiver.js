"use strict";
const crypto = require("node:crypto");
const {pool} = require("../db/db");
const {clinicSecondNumberApproved} = require("./pr395StagingSafety");

// This receiver is deliberately NOT a WhatsApp conversation handler.
// It records only business-account lifecycle metadata, never customer data.
function digits(v){return String(v||"").replace(/\D/g,"");}
function enabled(env=process.env){
 const target=String(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164||"");
 return env.PR395_STAGING_MODE==="true" &&
   env.PR395_STAGING_PREIDENTITY_RECEIVER_ENABLED==="true" &&
   env.PR395_STAGING_PROVIDER_REHEARSAL_ENABLED!=="true" &&
   env.PR395_STAGING_ALLOW_PROVIDER_PROCESSING!=="true" &&
   env.WHATSAPP_SECONDARY_SENDER_KEY==="coexistence_qa" &&
   /^\+[1-9]\d{7,14}$/.test(target) &&
   target===env.PR395_STAGING_APPROVED_TEST_PHONE_E164 &&
   (target!=="+60174831336" || clinicSecondNumberApproved(env)) &&
   digits(target)!==digits(env.WHATSAPP_PHONE_NUMBER||"") &&
   !String(env.WHATSAPP_SECONDARY_WABA_ID||"").trim() &&
   !String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID||"").trim() &&
   !String(env.WHATSAPP_SECONDARY_EXPECTED_WABA_ID||"").trim() &&
   !String(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID||"").trim() &&
   !!env.WHATSAPP_APP_SECRET &&
   env.WHATSAPP_APP_SECRET===env.META_APP_SECRET;
}
function inspectPreidentityBatch(body,env=process.env){
 if(!enabled(env))throw Error("Preidentity receiver unavailable");
 if(body?.object!=="whatsapp_business_account"||
    !Array.isArray(body.entry)||body.entry.length===0||body.entry.length>200)
   throw Error("Invalid preidentity account batch");
 const accepted=[];
 for(const entry of body.entry){
   const account=String(entry?.id||"");
   if(!/^\d+$/.test(account)||
      account===String(env.WHATSAPP_WABA_ID||"") ||
      !Array.isArray(entry.changes) ||
      !entry.changes.length||entry.changes.length>200) {
     throw Error("Unverified or primary account identity in preidentity batch");
   }
   for(const change of entry.changes){
     if(change?.field!=="account_update" || !change?.value ||
        typeof change.value!=="object"||Array.isArray(change.value)||
        typeof change.value.phone_number!=="string" ||
        digits(change.value.phone_number)!==
          digits(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164)) {
       throw Error("Foreign or non-lifecycle preidentity event");
     }
     const type=change.value.event;
     if(typeof type!=="string"||!/^[-A-Z0-9_]{1,64}$/.test(type))
       throw Error("Unknown preidentity event type format");
     const entryTime=entry.time==null?null:Number(entry.time);
     if(entryTime!==null && (!Number.isSafeInteger(entryTime)||entryTime<=0))
       throw Error("Invalid preidentity provider timestamp");
     const fingerprint=crypto.createHash("sha256").update(JSON.stringify({
       account,entryTime,change
     })).digest("hex");
     accepted.push({fingerprint,account,eventType:type,entryTime});
   }
 }
 if(accepted.length>200)throw Error("Preidentity event batch limit exceeded");
 return accepted;
}
async function acceptPreidentityBatch(body,{database=pool,env=process.env}={}){
 const events=inspectPreidentityBatch(body,env);
 const client=await database.connect();
 let started=false;
 try{
   await client.query("BEGIN");started=true;
   let inserted=0;
   for(const e of events){
     const result=await client.query(
       `INSERT INTO whatsapp_coexistence_preidentity_events
         (fingerprint,candidate_waba_id,candidate_phone_e164,event_type,entry_time)
        VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(fingerprint) DO NOTHING RETURNING fingerprint`,
       [e.fingerprint,e.account,env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164,
        e.eventType,e.entryTime]
     );
     if(result.rowCount===1)inserted++;
   }
   await client.query("COMMIT");started=false;
   return{durable:true,inserted,accepted:events.length};
 }catch(error){
   if(started)await client.query("ROLLBACK").catch(()=>{});
   throw error;
 }finally{client.release();}
}
module.exports={enabled,inspectPreidentityBatch,acceptPreidentityBatch};
