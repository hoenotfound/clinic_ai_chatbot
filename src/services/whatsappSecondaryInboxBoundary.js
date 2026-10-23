"use strict";

// Fully passive until explicit secondary Inbox-only opt-in. Never select the
// primary's Meta credentials for a secondary sender.
const crypto=require("node:crypto");
const { partitionLegacyWhatsAppWebhook }=require("./whatsappLegacySenderBoundary");

function fingerprint(accountId,change) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({account:accountId,change})).digest("hex");
}
function partitionSecondaryInboxWebhook(body,{
  primaryPhoneId,primaryAccountId,secondaryPhoneId,secondaryAccountId
}={}) {
  if(!/^[0-9]+$/.test(String(primaryPhoneId||"")) ||
     !/^[0-9]+$/.test(String(primaryAccountId||"")) ||
     !/^[0-9]+$/.test(String(secondaryPhoneId||"")) ||
     !/^[0-9]+$/.test(String(secondaryAccountId||"")) ||
     primaryPhoneId===secondaryPhoneId) {
    throw new Error("Secondary Inbox receiver needs two distinct verified Meta numbers.");
  }
  const primary=partitionLegacyWhatsAppWebhook(body,{
    expectedPhoneNumberId:primaryPhoneId,expectedAccountId:primaryAccountId,
    strictAccount:true,strictMissingMetadata:true
  });
  const secondary=partitionLegacyWhatsAppWebhook(body,{
    expectedPhoneNumberId:secondaryPhoneId,expectedAccountId:secondaryAccountId,
    strictAccount:true,strictMissingMetadata:true
  });
  const supported=new Set(["messages","smb_message_echoes"]);
  const accepted=[];
  const deferredStatuses=[];
  const allowedFingerprints=new Set();
  let secondaryActionable=0;
  for(const entry of secondary.acceptedBody.entry) {
    const changes=[];
    for(const change of entry.changes) {
      if(!supported.has(change.field))continue;
      const actualPhone=change.value?.metadata?.phone_number_id;
      if(actualPhone!==secondaryPhoneId||entry.id!==secondaryAccountId)continue;
      const digest=fingerprint(entry.id,change);
      allowedFingerprints.add(digest);
      if(change.field==="messages") {
        // There is no secondary Cloud API outbound in this receiving stage.
        // Never let Ariel status/pricing receipts enter Neutro's durable billing
        // gate, retry workers or delivery-attention updates.
        if(change.value.statuses?.length) {
          deferredStatuses.push(Object.freeze({
            fingerprint:digest,reason:"unsupported_whatsapp_event",
            field:"messages",accountId:entry.id,
            phoneNumberId:actualPhone,
          }));
        }
        if(!change.value.messages?.length)continue;
        const { statuses, ...safeValue }=change.value;
        changes.push({...change,value:safeValue});
      } else {
        changes.push(change);
      }
      secondaryActionable++;
    }
    if(changes.length)accepted.push({...entry,changes});
  }
  // The legacy parser deliberately tolerates passive sync without phone
  // metadata. Restrict it to the two explicitly configured Meta accounts here:
  // unrecognized app-state/history events cannot be silently accepted.
  const foreignPassive=[];
  const primaryEntries=primary.acceptedBody.entry.flatMap(entry=>{
    const changes=entry.changes.filter(change=>{
      if((change.field==="history"||change.field==="smb_app_state_sync") &&
         entry.id!==primaryAccountId && entry.id!==secondaryAccountId) {
        foreignPassive.push(Object.freeze({
          fingerprint:fingerprint(entry.id,change),
          reason:"different_business_account",field:change.field,
          accountId:entry.id||null,
          phoneNumberId:change.value?.metadata?.phone_number_id||null,
        }));
        return false;
      }
      return true;
    });
    return changes.length?[{...entry,changes}]:[];
  });
  const entries=[...primaryEntries,...accepted];
  const quarantined=[
    ...primary.quarantined.filter(q=>!allowedFingerprints.has(q.fingerprint)),
    ...deferredStatuses,...foreignPassive,
  ];
  if(quarantined.length>200)throw new Error("WhatsApp quarantine limit exceeded.");
  return {
    ...primary,
    acceptedBody:{object:"whatsapp_business_account",entry:entries},
    acceptedChanges:entries.reduce((n,e)=>n+e.changes.length,0),
    acceptedActionable:primary.acceptedActionable+secondaryActionable,
    quarantined,
  };
}
module.exports={partitionSecondaryInboxWebhook};
