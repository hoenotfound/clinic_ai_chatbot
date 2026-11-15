"use strict";

// A successful delivery callback for an already-authored automated follow-up
// does not create a new first business reply, marketing consent, due slot or
// accepted attempt. First-reply/131060 recovery receipts and failures must
// still wake both secondary schedulers. This hint never authorizes a send.
const SUCCESSFUL_DELIVERY_STATUSES=new Set(["sent","delivered","read"]);

function automatedSecondaryReceiptDoesNotChangeEligibility({
  message,providerStatus,senderVerified,scope,env=process.env,
}={}){
  const secondaryId=String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID||"").trim();
  return senderVerified===true &&
    secondaryId.length>0 &&
    scope?.channel==="whatsapp" &&
    String(scope?.businessPhoneNumberId||"")===secondaryId &&
    message?.role==="assistant" &&
    message?.is_automated_follow_up===true &&
    SUCCESSFUL_DELIVERY_STATUSES.has(providerStatus) &&
    SUCCESSFUL_DELIVERY_STATUSES.has(message.delivery_status);
}

module.exports={automatedSecondaryReceiptDoesNotChangeEligibility};
