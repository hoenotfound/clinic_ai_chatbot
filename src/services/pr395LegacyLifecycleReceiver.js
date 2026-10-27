"use strict";
// A signed, audit-only legacy account_update receiver. This service is *not*
// a legacy chatbot and does NOT alter sender status, AI, or customer messages.
const crypto=require("node:crypto");
const {pool}=require("../db/db");
const SWITCH="PR395_STAGING_LEGACY_LIFECYCLE_ENABLED";
function digits(value){return String(value||"").replace(/\D/g,"");}
function enabled(env=process.env){
 const waba=String(env.PR395_STAGING_LEGACY_WABA_ID||"");
 const phone=String(env.PR395_STAGING_LEGACY_PHONE_E164||"");
 const qa=String(env.PR395_STAGING_APPROVED_TEST_PHONE_E164||"");
 return env.PR395_STAGING_MODE==="true" && env[SWITCH]==="true" &&
   env.WHATSAPP_SECONDARY_SENDER_KEY==="coexistence_qa" &&
   env.PR395_STAGING_PROVIDER_REHEARSAL_ENABLED!=="true" &&
   env.PR395_STAGING_ALLOW_PROVIDER_PROCESSING!=="true" &&
   /^\d+$/.test(waba) && /^\+[1-9]\d{7,14}$/.test(phone) &&
   /^\+[1-9]\d{7,14}$/.test(qa) && digits(phone)!==digits(qa) &&
   String(env.WHATSAPP_APP_SECRET||"").length>=24 &&
   env.WHATSAPP_APP_SECRET===env.META_APP_SECRET &&
   !String(env.WHATSAPP_SECONDARY_WABA_ID||"").trim() &&
   !String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID||"").trim();
}
function inspectBatch(body,env=process.env){
 if(!enabled(env))throw Error("Legacy lifecycle receiver is locked");
 if(body?.object!=="whatsapp_business_account"||
    !Array.isArray(body.entry)||body.entry.length<1||body.entry.length>200)
   throw Error("Invalid legacy lifecycle payload");
 const events=[];
 const waba=String(env.PR395_STAGING_LEGACY_WABA_ID);
 const phone=String(env.PR395_STAGING_LEGACY_PHONE_E164);
 for(const entry of body.entry){
   if(String(entry?.id||"")!==waba||
      !Array.isArray(entry.changes)||
      !entry.changes.length||entry.changes.length>200)
     throw Error("Legacy lifecycle WABA mismatch");
   for(const change of entry.changes){
     if(change?.field!=="account_update"||!change.value||
        typeof change.value!=="object"||Array.isArray(change.value))
       throw Error("Only legacy account_update may be recorded here");
     const event=change.value.event;
     if(typeof event!=="string"||!/^[A-Z][A-Z0-9_]{0,63}$/.test(event))
       throw Error("Invalid legacy event type");
     const supplied=change.value.phone_number;
     if(supplied!=null&&(typeof supplied!=="string"||digits(supplied)!==digits(phone)))
       throw Error("Legacy event phone does not match the verified business");
     const entryTime=entry.time==null?null:Number(entry.time);
     if(entryTime!==null&&(!Number.isSafeInteger(entryTime)||entryTime<=0))
       throw Error("Invalid legacy lifecycle timestamp");
     // The raw value is used only in the SHA-256 fingerprint, not persisted.
     const fingerprint=crypto.createHash("sha256").update(JSON.stringify({
       account:waba,entryTime,change
     })).digest("hex");
     events.push(Object.freeze({
       fingerprint,account:waba,eventType:event,
       phone:supplied==null?null:phone,entryTime
     }));
   }
 }
 if(events.length>200)throw Error("Legacy lifecycle batch limit exceeded");
 return events;
}
async function recordBatch(body,{env=process.env,database=pool}={}){
 const events=inspectBatch(body,env);
 const connection=await database.connect();
 let transaction=false;
 try{
   await connection.query("BEGIN");transaction=true;
   let inserted=0;
   for(const event of events){
     const row=await connection.query(
       "INSERT INTO whatsapp_legacy_lifecycle_relay_audit "+
       "(fingerprint,account_id,event_type,account_phone_e164,entry_time) "+
       "VALUES($1,$2,$3,$4,$5) "+
       "ON CONFLICT(fingerprint) DO NOTHING RETURNING fingerprint",
       [event.fingerprint,event.account,event.eventType,event.phone,event.entryTime]
     );
     if(row.rowCount===1){
       inserted++;
       // Alert and signed audit commit atomically. Never disable or modify
       // the legacy production sender based on a staging callback.
       const critical=new Set([
         "PARTNER_REMOVED","ACCOUNT_OFFBOARDED","ACCOUNT_DISCONNECTED",
         "PHONE_NUMBER_REMOVED","ACCOUNT_DISABLED","DISCONNECTED"
       ]).has(event.eventType);
       await connection.query(
         "INSERT INTO whatsapp_pr395_legacy_lifecycle_alerts "+
         "(fingerprint,account_id,event_type,severity) VALUES($1,$2,$3,$4) "+
         "ON CONFLICT(fingerprint) DO NOTHING",
         [event.fingerprint,event.account,event.eventType,
          critical?"critical":"review"]
       );
     }
   }
   await connection.query("COMMIT");transaction=false;
   return{durable:true,accepted:events.length,inserted};
 }catch(error){
   if(transaction)await connection.query("ROLLBACK").catch(()=>{});
   throw error;
 }finally{connection.release();}
}
module.exports={enabled,inspectBatch,recordBatch,SWITCH};
