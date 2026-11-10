"use strict";
const {pool} = require("./db");
const { is131060RecoveryAssistantSql } = require("../utils/whatsapp131060RecoverySql");

/**
 * Store only durable IDs, after checking BOTH Meta inbound webhook payloads,
 * the matching CTWA referral, the active secondary sender conversation and
 * exact first-message ordering. There is no historical message replay.
 *
 * This proof outlives the normal 24h inbound_processing_jobs cleanup and is
 * deleted by the existing FK cascades when the contact/messages are erased.
 */
async function recordVerifiedFirstAd({contactId,inboundMessageId,adId},database=pool){
  const contact=Number(contactId), inbound=Number(inboundMessageId);
  if(!Number.isSafeInteger(contact)||contact<=0||
     !Number.isSafeInteger(inbound)||inbound<=0||
     !/^[A-Za-z0-9_.:-]{1,256}$/.test(String(adId||"")))return null;
  const result=await database.query({
    text:`INSERT INTO whatsapp_secondary_131060_first_ads
      (contact_id,sender_id,unavailable_message_id,first_ad_message_id,meta_ad_id)
     SELECT c.id,sa.id,initial.id,ad_message.id,$3
     FROM contacts c
     JOIN whatsapp_sender_accounts sa ON sa.id=c.whatsapp_sender_id
       AND sa.sender_key='neutro_secondary' AND sa.state='active'
     JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
       AND sc.contact_id=c.id AND sc.state='bound'
       AND sc.customer_wa_id=c.whatsapp_number
     JOIN messages ad_message ON ad_message.id=$2 AND ad_message.contact_id=c.id
       AND ad_message.role='user' AND ad_message.whatsapp_message_id IS NOT NULL
       AND ad_message.source_created_at IS NOT NULL
     JOIN whatsapp_sender_message_context ad_ctx ON ad_ctx.message_id=ad_message.id
       AND ad_ctx.conversation_id=sc.id
     JOIN inbound_processing_jobs ad_job ON ad_job.message_id=ad_message.id
       AND ad_job.channel='whatsapp'
       AND ad_job.incoming_payload->'attribution'->>'source'='meta_ads'
       AND ad_job.incoming_payload->'attribution'->>'sourceType'='ad'
       AND ad_job.incoming_payload->'attribution'->>'adId'=$3
       AND NULLIF(BTRIM(ad_job.incoming_payload->>'text'),'') IS NOT NULL
     JOIN whatsapp_free_entry_referrals referral ON referral.origin_message_id=ad_message.id
       AND referral.contact_id=c.id AND referral.source_type='ad'
       AND referral.meta_ad_id=$3
     JOIN messages initial ON initial.contact_id=c.id AND initial.role='user'
       AND initial.whatsapp_message_id IS NOT NULL
       AND initial.source_created_at IS NOT NULL
       AND (initial.created_at,initial.id)<(ad_message.created_at,ad_message.id)
     JOIN whatsapp_sender_message_context first_ctx ON first_ctx.message_id=initial.id
       AND first_ctx.conversation_id=sc.id
     JOIN inbound_processing_jobs initial_job ON initial_job.message_id=initial.id
       AND initial_job.channel='whatsapp'
       AND initial_job.incoming_payload->>'unsupportedType'='unsupported'
       AND initial_job.incoming_payload->'unsupportedErrors'
          @> '[{"code":131060}]'::jsonb
     WHERE c.id=$1 AND c.channel='whatsapp'
       AND ad_message.created_at<=initial.created_at+INTERVAL '2 minutes'
       AND ad_message.source_created_at>=initial.source_created_at
       AND ad_message.source_created_at<=initial.source_created_at+INTERVAL '2 minutes'
       AND NOT EXISTS(
         SELECT 1 FROM messages prior
         WHERE prior.contact_id=c.id
           AND (prior.created_at,prior.id)<(ad_message.created_at,ad_message.id)
           AND prior.id<>initial.id
           AND NOT ${is131060RecoveryAssistantSql("prior","initial")}
       )
     LIMIT 1
     ON CONFLICT (contact_id) DO UPDATE SET
       verified_at=whatsapp_secondary_131060_first_ads.verified_at
     WHERE whatsapp_secondary_131060_first_ads.sender_id=EXCLUDED.sender_id
       AND whatsapp_secondary_131060_first_ads.unavailable_message_id=EXCLUDED.unavailable_message_id
       AND whatsapp_secondary_131060_first_ads.first_ad_message_id=EXCLUDED.first_ad_message_id
       AND whatsapp_secondary_131060_first_ads.meta_ad_id=EXCLUDED.meta_ad_id
     RETURNING first_ad_message_id,unavailable_message_id,contact_id,meta_ad_id`,
    values:[contact,inbound,String(adId)],
    query_timeout:1500,
  });
  return result.rows?.[0]||null;
}

/**
 * This read is not advertising authorization by itself. It only decides
 * whether the first readable message may use first-turn greeting and early
 * contextual-result presentation. All existing sender and safety checks apply.
 */
async function getVerifiedFirstAdMessage(contactId,messageId,database=pool){
  const contact=Number(contactId),id=Number(messageId);
  if(!Number.isSafeInteger(contact)||contact<=0||
     !Number.isSafeInteger(id)||id<=0)return null;
  const result=await database.query(
    `SELECT proof.first_ad_message_id,proof.unavailable_message_id
     FROM whatsapp_secondary_131060_first_ads proof
     JOIN contacts c ON c.id=proof.contact_id AND c.channel='whatsapp'
     JOIN whatsapp_sender_accounts sa ON sa.id=proof.sender_id
       AND sa.id=c.whatsapp_sender_id AND sa.state='active'
       AND sa.sender_key='neutro_secondary'
     JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
       AND sc.contact_id=c.id AND sc.state='bound'
       AND sc.customer_wa_id=c.whatsapp_number
     JOIN whatsapp_sender_message_context real_ctx ON real_ctx.message_id=proof.first_ad_message_id
       AND real_ctx.conversation_id=sc.id
     JOIN whatsapp_sender_message_context prior_ctx ON prior_ctx.message_id=proof.unavailable_message_id
       AND prior_ctx.conversation_id=sc.id
     JOIN messages initial ON initial.id=proof.unavailable_message_id
       AND initial.contact_id=c.id
     WHERE proof.contact_id=$1 AND proof.first_ad_message_id=$2
       AND NOT EXISTS(
         SELECT 1 FROM messages previous
         JOIN messages ad_msg ON ad_msg.id=proof.first_ad_message_id
         WHERE previous.contact_id=c.id
           AND (previous.created_at,previous.id)<(ad_msg.created_at,ad_msg.id)
           AND previous.id<>proof.unavailable_message_id
           AND NOT ${is131060RecoveryAssistantSql("previous","initial")}
       )`,
    [contact,id]
  );
  return result.rows?.[0]||null;
}

module.exports={recordVerifiedFirstAd,getVerifiedFirstAdMessage};
