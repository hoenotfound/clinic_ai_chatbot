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
  const allowedFingerprints=new Set();
  let secondaryActionable=0;
  for(const entry of secondary.acceptedBody.entry) {
    const changes=entry.changes.filter(change=>{
      if(!supported.has(change.field))return false;
      const actualPhone=change.value?.metadata?.phone_number_id;
      if(actualPhone!==secondaryPhoneId||entry.id!==secondaryAccountId)return false;
      const n=change.field==="messages" ?
        ((change.value.messages?.length||0)+(change.value.statuses?.length||0)) :
        (change.value.message_echoes?.length||0);
      if(n)secondaryActionable++;
      allowedFingerprints.add(fingerprint(entry.id,change));
      return true;
    });
    if(changes.length)accepted.push({...entry,changes});
  }
  const entries=[...primary.acceptedBody.entry,...accepted];
  return {
    ...primary,
    acceptedBody:{object:"whatsapp_business_account",entry:entries},
    acceptedChanges:entries.reduce((n,e)=>n+e.changes.length,0),
    acceptedActionable:primary.acceptedActionable+secondaryActionable,
    quarantined:primary.quarantined.filter(q=>!allowedFingerprints.has(q.fingerprint)),
  };
}
module.exports={partitionSecondaryInboxWebhook};
