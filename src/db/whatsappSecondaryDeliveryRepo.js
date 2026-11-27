"use strict";
const crypto=require("node:crypto");
const {pool}=require("./db");
const {normalizeCustomerAddress,isBsuid}=require("../utils/whatsappCustomerIdentity");
const {applyStagedSecondaryReceipts}=require("./whatsappSenderEarlyReceiptRepo");
const {deliveryOnlyEnabled}=require("../utils/whatsappSecondaryDeliveryOnly");
const deny=code=>({reserved:false,recorded:false,sendAuthorized:false,code});
const OWNER_SQL = `
 SELECT sa.id AS sender_id,
   COALESCE(c.whatsapp_last_customer_address,c.whatsapp_number) AS recipient_address,
   c.whatsapp_user_id,
   (EXISTS(
      SELECT 1 FROM whatsapp_manual_template_billing_claims claim
      WHERE claim.token_hash=m.whatsapp_template->>'billingReviewClaimHash'
        AND claim.contact_id=m.contact_id
        AND claim.template_name=m.whatsapp_template->>'name'
        AND claim.language_code=m.whatsapp_template->>'language'
        AND claim.claimed_at>=NOW()-INTERVAL '10 minutes'
    )) AS has_staff_template_billing_review,
   (m.is_automated_follow_up=TRUE
     AND m.sent_by_username IS NULL
     AND m.whatsapp_template->>'automatedSecondaryMarketingFollowup'='true'
     AND m.whatsapp_template->>'senderKey'=sa.sender_key
     AND m.whatsapp_template->>'slotHours' IN ('48','66','72','96','144')
     AND m.whatsapp_template->>'name' ~ '^[a-z0-9_]+$'
     AND EXISTS (
       SELECT 1 FROM whatsapp_sender_marketing_followup_attempts att
       JOIN whatsapp_sender_marketing_followup_rules rule
         ON rule.sender_id=att.sender_id AND rule.slot_hours=att.slot_hours
         AND rule.enabled=TRUE
       JOIN messages inbound ON inbound.id=att.anchor_message_id
         AND inbound.contact_id=m.contact_id
         AND inbound.role='user' AND inbound.whatsapp_message_id IS NOT NULL
       JOIN whatsapp_sender_message_context inbound_mc
         ON inbound_mc.message_id=inbound.id
         AND inbound_mc.conversation_id=sc.id
       WHERE att.sender_id=sa.id AND att.contact_id=m.contact_id
         AND att.message_id=m.id AND att.status='claimed'
         AND att.slot_hours::text=m.whatsapp_template->>'slotHours'
         AND att.anchor_message_id::text=m.whatsapp_template->>'anchorMessageId'
         AND rule.template_name=m.whatsapp_template->>'name'
         AND rule.language_code=m.whatsapp_template->>'language'
         AND rule.template_signature=m.whatsapp_template->>'templateSignature'
         AND NOT EXISTS(
           SELECT 1 FROM whatsapp_sender_coexistence_history_messages h
           WHERE h.sender_id=sa.id AND h.message_id=inbound.id
         )
     )
   ) AS has_automated_marketing_billing_approval,
   m.whatsapp_template->>'templateSignature' AS template_signature,
   m.whatsapp_template->>'billingReviewClaimHash' AS billing_review_claim_hash,
   (m.whatsapp_template IS NULL OR (
     m.is_automated_follow_up = TRUE
     AND m.whatsapp_template->>'automatedSecondaryFollowup' = 'true'
     AND m.whatsapp_template->>'senderKey' = sa.sender_key
     AND m.whatsapp_template->>'slotHours' IN ('2','6','20')
     AND m.whatsapp_template->>'anchorMessageId' ~ '^[0-9]+$'
     AND m.whatsapp_template->>'name' IS NULL
   ) OR (
     -- A queued AI graphic is freeform only when the one-shot claimed job
     -- matches sender, original signed inbound and this outbound row.
     m.is_automated_follow_up IS DISTINCT FROM TRUE
     AND m.sent_by_username IS NULL
     AND m.whatsapp_template->>'automatedSecondaryAiMedia' = 'true'
     AND m.whatsapp_template->>'senderKey' = sa.sender_key
     AND m.whatsapp_template->>'name' IS NULL
     AND m.whatsapp_template->>'anchorMessageId' ~ '^[0-9]+$'
     AND EXISTS (
       SELECT 1 FROM whatsapp_sender_ai_media_jobs job
       JOIN messages inbound ON inbound.id=job.inbound_message_id
         AND inbound.contact_id=m.contact_id
         AND inbound.role='user'
         AND inbound.whatsapp_message_id IS NOT NULL
       JOIN whatsapp_sender_message_context inbound_ctx
         ON inbound_ctx.message_id=inbound.id
         AND inbound_ctx.conversation_id=sc.id
       WHERE job.sender_id=sa.id AND job.contact_id=m.contact_id
         AND job.outbound_message_id=m.id
         AND job.state='claimed' AND job.expires_at>NOW()
         AND job.media_kind IN ('promotion','result')
         AND job.image_url=m.media_url
         AND m.whatsapp_template->>'anchorMessageId'=job.inbound_message_id::text
     )
   )) AS is_freeform_service
 FROM messages m
 JOIN contacts c ON c.id=m.contact_id AND c.channel='whatsapp'
 JOIN whatsapp_sender_conversations sc ON sc.contact_id=c.id
   AND sc.sender_id=c.whatsapp_sender_id AND sc.state='bound'
 JOIN whatsapp_sender_message_context mc ON mc.message_id=m.id
   AND mc.conversation_id=sc.id
 JOIN whatsapp_sender_accounts sa ON sa.id=sc.sender_id
 WHERE m.id=$2 AND c.id=$1 AND m.role='assistant'
   AND m.whatsapp_message_id IS NULL AND m.whatsapp_accepted_at IS NULL
   AND sa.state='active' AND sa.sender_key=$3
   AND sa.meta_phone_number_id=$4 AND sa.meta_account_id=$5
   AND sc.customer_wa_id=c.whatsapp_number
 FOR UPDATE OF m
`;
async function claim({contactId,messageId,expectedTemplateSignature=null,origin=null},{database=pool,env=process.env}={}){
 if(!deliveryOnlyEnabled(env))return deny("secondary_delivery_mode_disabled");
 let client,tx=false;
 try{
  client=await database.connect();await client.query("BEGIN");tx=true;
  const owner=await client.query(OWNER_SQL,[contactId,messageId,env.WHATSAPP_SECONDARY_SENDER_KEY,
    env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID]);
  const row=owner.rows?.[0];
  if(owner.rows?.length!==1||normalizeCustomerAddress(row.recipient_address)!==row.recipient_address||
    (isBsuid(row.recipient_address)&&row.whatsapp_user_id!==row.recipient_address)){
   await client.query("ROLLBACK");tx=false;return deny("secondary_delivery_owner_unverified");
  }
  const template=expectedTemplateSignature!==null;
  const authorized=template
    ? /^[a-f0-9]{64}$/.test(expectedTemplateSignature) && row.template_signature===expectedTemplateSignature &&
      (origin==="staff" && row.has_staff_template_billing_review===true ||
       origin==="marketing_followup" && row.has_automated_marketing_billing_approval===true)
    : row.is_freeform_service===true;
  if(!authorized){await client.query("ROLLBACK");tx=false;return deny("secondary_delivery_content_unverified");}
  const prior=await client.query(`SELECT 1 FROM whatsapp_sender_billing_attempts WHERE message_id=$1
    UNION ALL SELECT 1 FROM outbound_message_evidence WHERE message_id=$1 AND accepted=TRUE LIMIT 1`,[messageId]);
  if(prior.rows?.length){await client.query("ROLLBACK");tx=false;return deny("secondary_delivery_already_attempted");}
  const reservationId=crypto.randomUUID();
  // Reuse the historical attempt table solely as a durable one-shot delivery
  // ledger. No billing authorization, per-contact gate or pricing settlement.
  await client.query(`INSERT INTO whatsapp_sender_billing_attempts
    (reservation_id,sender_id,contact_id,message_id,recipient_address,delivery_only)
    VALUES($1,$2,$3,$4,$5,TRUE)`,[reservationId,row.sender_id,contactId,messageId,row.recipient_address]);
  await client.query("COMMIT");tx=false;
  return {reserved:true,reservationId,recipientAddress:row.recipient_address,sendAuthorized:false};
 }catch{if(tx)await client.query("ROLLBACK").catch(()=>{});return deny("secondary_delivery_database_unavailable");}
 finally{if(client)client.release();}
}
const ALLOWED_DELIVERY_SQL=`
 SELECT a.reservation_id FROM whatsapp_sender_billing_attempts a
 JOIN whatsapp_sender_accounts sa ON sa.id=a.sender_id AND sa.state='active'
 JOIN contacts c ON c.id=a.contact_id AND c.whatsapp_sender_id=a.sender_id
 JOIN messages m ON m.id=a.message_id AND m.contact_id=c.id AND m.role='assistant'
 JOIN whatsapp_sender_conversations sc ON sc.contact_id=c.id AND sc.sender_id=sa.id AND sc.state='bound'
   AND sc.customer_wa_id=c.whatsapp_number
 JOIN whatsapp_sender_message_context mc ON mc.message_id=m.id AND mc.conversation_id=sc.id
 WHERE sa.sender_key=$1 AND sa.meta_phone_number_id=$2 AND sa.meta_account_id=$3
   AND a.reservation_id=$4::uuid AND a.contact_id=$5 AND a.message_id=$6
   AND a.delivery_only=TRUE AND a.state='reserved' AND a.wamid IS NULL
   AND m.whatsapp_message_id IS NULL AND m.whatsapp_accepted_at IS NULL
   AND a.recipient_address=COALESCE(c.whatsapp_last_customer_address,c.whatsapp_number)`;
async function record({reservationId,acceptedWamid=null,definitivelyRejected=false},{database=pool,env=process.env}={}){
 if(!deliveryOnlyEnabled(env)||(!acceptedWamid&&definitivelyRejected!==true&&definitivelyRejected!==false)||
    (acceptedWamid&&(!/^wamid\./.test(acceptedWamid)||definitivelyRejected)))return deny("secondary_delivery_invalid_outcome");
 let client,tx=false;
 try{
  client=await database.connect();await client.query("BEGIN");tx=true;
  const sender=await client.query(`SELECT id FROM whatsapp_sender_accounts WHERE sender_key=$1 AND meta_phone_number_id=$2
    AND meta_account_id=$3 AND state='active' FOR UPDATE`,[env.WHATSAPP_SECONDARY_SENDER_KEY,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID]);
  if(sender.rows?.length!==1){await client.query("ROLLBACK");tx=false;return deny("secondary_delivery_owner_unverified");}
  const owner=await client.query(`SELECT a.sender_id,a.contact_id,a.message_id,a.state,a.wamid FROM whatsapp_sender_billing_attempts a
    JOIN contacts c ON c.id=a.contact_id AND c.whatsapp_sender_id=a.sender_id
    JOIN messages m ON m.id=a.message_id AND m.contact_id=c.id AND m.role='assistant'
    WHERE a.reservation_id=$1::uuid AND a.sender_id=$2 AND a.delivery_only=TRUE
      AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_billing_gates g WHERE g.reservation_id=a.reservation_id)
    FOR UPDATE OF a`,[reservationId,sender.rows[0].id]);
  const a=owner.rows?.[0];
  if(!a||a.state!=="reserved"){await client.query("ROLLBACK");tx=false;return deny("secondary_delivery_claim_not_found");}
  const state=acceptedWamid?"accepted":definitivelyRejected?"rejected":"unknown";
  const updated=await client.query("UPDATE whatsapp_sender_billing_attempts SET state=$2,wamid=$3,updated_at=NOW() WHERE reservation_id=$1::uuid AND state='reserved'",[reservationId,state,acceptedWamid]);
  if(updated.rowCount!==1)throw Error("Delivery claim changed");
  if(acceptedWamid)await applyStagedSecondaryReceipts({client,senderId:a.sender_id,contactId:a.contact_id,messageId:a.message_id,reservationId,acceptedWamid,env,deliveryOnly:true});
  await client.query("COMMIT");tx=false;return {recorded:true,state,sendAuthorized:false};
 }catch{if(tx)await client.query("ROLLBACK").catch(()=>{});return deny("secondary_delivery_database_unavailable");}
 finally{if(client)client.release();}
}
module.exports={claim,record,ALLOWED_DELIVERY_SQL};
