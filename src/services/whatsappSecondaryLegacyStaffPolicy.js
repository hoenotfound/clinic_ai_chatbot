"use strict";
// Neutro secondary only. Old contacts are effectively staff-managed until
// they initiate a new sender-bound Meta Click-to-WhatsApp ad session.
// This is an eligibility rule, not a bulk change to human takeover records.
function secondaryLegacyStaffCutoff(env=process.env){
 if(env.WHATSAPP_SECONDARY_LEGACY_STAFF_MODE_ENABLED!=="true")return null;
 const s=String(env.WHATSAPP_SECONDARY_LEGACY_STAFF_ACTIVATED_AT||"");
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(s))return null;
 const d=new Date(s);
 return Number.isFinite(d.getTime())?d.toISOString():null;
}
function secondaryLegacyStaffAudienceSql(contact="c",anchor=null,env=process.env){
 for(const name of [contact,...(anchor?[anchor]:[])])
   if(!/^[a-z][a-z0-9_]*$/i.test(name))throw new Error("Invalid SQL alias");
 if(env.WHATSAPP_SECONDARY_LEGACY_STAFF_MODE_ENABLED!=="true")return "TRUE";
 const cutoff=secondaryLegacyStaffCutoff(env);
 if(!cutoff)return "FALSE";
 // Date is strict ISO-8601 and normalized by Date.toISOString(), never raw SQL.
 const at="'"+cutoff+"'::timestamptz";
 const anchorTime=anchor?anchor+".created_at":"NOW()";
 // A genuine ad received before the policy cutover remains useful evidence
 // for seven days. It does not by itself re-enable old contacts. Only a NEW,
 // readable, provider-bound customer message after cutover can renew AI access.
 // This never creates an ad referral or marketing consent.
 const postCutoverReadable=alias=>`
       ${alias}.role='user'
       AND ${alias}.whatsapp_message_id IS NOT NULL
       AND ${alias}.source_created_at IS NOT NULL
       AND ${alias}.created_at>=${at}
       AND ${alias}.source_created_at>=${at}
       -- Never restart AI from an empty or system-generated unsupported
       -- message. All inbound unsupported/attachment notices use this prefix.
       AND NULLIF(BTRIM(${alias}.content),'') IS NOT NULL
       AND ${alias}.content NOT LIKE '📎 [%'
       AND ${alias}.id>ad_inbound.id
       AND ${alias}.created_at>=ad_inbound.created_at
       AND ${alias}.created_at<ad_inbound.created_at+INTERVAL '7 days'`;
 const renewedBeforeCutoverAd=anchor?
   `AND ${postCutoverReadable(anchor)}
      AND EXISTS (
        SELECT 1 FROM whatsapp_sender_message_context renewed_context
        WHERE renewed_context.message_id=${anchor}.id
          AND renewed_context.conversation_id=ad_conversation.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM whatsapp_sender_coexistence_history_messages renewed_history
        WHERE renewed_history.message_id=${anchor}.id
          AND renewed_history.sender_id=ad_conversation.sender_id
      )`:
   `AND EXISTS (
        SELECT 1 FROM messages renewed_inbound
        JOIN whatsapp_sender_message_context renewed_context
          ON renewed_context.message_id=renewed_inbound.id
         AND renewed_context.conversation_id=ad_conversation.id
        WHERE renewed_inbound.contact_id=${contact}.id
          AND ${postCutoverReadable("renewed_inbound")}
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_sender_coexistence_history_messages renewed_history
            WHERE renewed_history.message_id=renewed_inbound.id
              AND renewed_history.sender_id=ad_conversation.sender_id
          )
      )`;
 const ordering=anchor?
   `AND (ad_inbound.created_at,ad_inbound.id)<=(
      ${anchor}.created_at,${anchor}.id)
    AND ${anchor}.created_at<ad_inbound.created_at+INTERVAL '7 days'
    AND ${anchor}.source_created_at IS NOT NULL
    AND ${anchor}.source_created_at>=${at}`:
   `AND NOW()<ad_inbound.created_at+INTERVAL '7 days'`;
 return `(
    (${contact}.created_at>=${at}
      AND ${contact}.whatsapp_coexistence_imported_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM messages old_contact_turn
        WHERE old_contact_turn.contact_id=${contact}.id
          AND COALESCE(old_contact_turn.source_created_at,
                       old_contact_turn.created_at)<${at}
      )
    )
    OR EXISTS (
      SELECT 1 FROM whatsapp_free_entry_referrals verified_ad
      JOIN messages ad_inbound ON ad_inbound.id=verified_ad.origin_message_id
        AND ad_inbound.contact_id=${contact}.id
        AND ad_inbound.role='user'
        AND ad_inbound.whatsapp_message_id IS NOT NULL
        AND ad_inbound.source_created_at IS NOT NULL
      JOIN whatsapp_sender_conversations ad_conversation
        ON ad_conversation.contact_id=${contact}.id
        AND ad_conversation.sender_id=${contact}.whatsapp_sender_id
        AND ad_conversation.customer_wa_id=${contact}.whatsapp_number
        AND ad_conversation.state='bound'
      JOIN whatsapp_sender_message_context ad_context
        ON ad_context.message_id=ad_inbound.id
        AND ad_context.conversation_id=ad_conversation.id
      WHERE verified_ad.contact_id=${contact}.id
        AND verified_ad.source_type='ad'
        AND (NULLIF(BTRIM(verified_ad.ctwa_clid),'') IS NOT NULL
             OR NULLIF(BTRIM(verified_ad.meta_ad_id),'') IS NOT NULL)
        AND ad_inbound.created_at>=${at}
        AND ad_inbound.source_created_at>=${at}
        AND NOT EXISTS (
          SELECT 1 FROM whatsapp_sender_coexistence_history_messages ad_history
          WHERE ad_history.message_id=ad_inbound.id
            AND ad_history.sender_id=ad_conversation.sender_id
        )
        AND ${anchorTime}>=ad_inbound.created_at
        ${ordering}
    )
    OR EXISTS (
      SELECT 1 FROM whatsapp_free_entry_referrals prior_ad
      JOIN messages ad_inbound ON ad_inbound.id=prior_ad.origin_message_id
        AND ad_inbound.contact_id=${contact}.id
        AND ad_inbound.role='user'
        AND ad_inbound.whatsapp_message_id IS NOT NULL
        AND ad_inbound.source_created_at IS NOT NULL
      JOIN whatsapp_sender_conversations ad_conversation
        ON ad_conversation.contact_id=${contact}.id
        AND ad_conversation.sender_id=${contact}.whatsapp_sender_id
        AND ad_conversation.customer_wa_id=${contact}.whatsapp_number
        AND ad_conversation.state='bound'
      JOIN whatsapp_sender_message_context prior_context
        ON prior_context.message_id=ad_inbound.id
       AND prior_context.conversation_id=ad_conversation.id
      WHERE prior_ad.contact_id=${contact}.id
        AND prior_ad.source_type='ad'
        AND (NULLIF(BTRIM(prior_ad.ctwa_clid),'') IS NOT NULL
             OR NULLIF(BTRIM(prior_ad.meta_ad_id),'') IS NOT NULL)
        AND ad_inbound.created_at<${at}
        AND ad_inbound.source_created_at<${at}
        AND NOW()<ad_inbound.created_at+INTERVAL '7 days'
        AND NOT EXISTS (
          SELECT 1 FROM whatsapp_sender_coexistence_history_messages ad_history
          WHERE ad_history.message_id=ad_inbound.id
            AND ad_history.sender_id=ad_conversation.sender_id
        )
        ${renewedBeforeCutoverAd}
    )
    OR (
      -- Seven-day admin approval. Only future sender-bound customer messages
      -- can become reply or follow-up anchors; no prior queue is replayed.
      ${contact}.whatsapp_secondary_manual_ai_approved_at IS NOT NULL
      AND ${contact}.whatsapp_secondary_manual_ai_approved_until > NOW()
      ${anchor ? `AND ${anchor}.role='user'
        AND ${anchor}.whatsapp_message_id IS NOT NULL
        AND ${anchor}.source_created_at IS NOT NULL
        AND ${anchor}.source_created_at >= date_trunc('second', ${contact}.whatsapp_secondary_manual_ai_approved_at)
        AND ${anchor}.created_at >= ${contact}.whatsapp_secondary_manual_ai_approved_at
        AND ${anchor}.created_at < ${contact}.whatsapp_secondary_manual_ai_approved_until` : ""}
    )
    OR ${secondary131060RecoveryAudienceSql(contact,anchor,env)}
  )`;
}

/**
 * A verified Meta 131060 may arrive without any advertising referral.
 * A single accepted recovery menu followed by a readable customer inbound
 * re-opens conversation AI and service follow-ups for up to seven days.
 * The unreadable event itself is NEVER a follow-up anchor or ad attribution.
 */
function secondary131060RecoveryAudienceSql(contact="c",anchor=null,env=process.env) {
 for(const name of [contact,...(anchor?[anchor]:[])])
   if(!/^[a-z][a-z0-9_]*$/i.test(name))throw new Error("Invalid SQL alias");
 if(env.WHATSAPP_SECONDARY_131060_RECOVERY_ENABLED!=="true")return "FALSE";
 const cutoff=secondaryLegacyStaffCutoff(env);
 const raw=String(env.WHATSAPP_SECONDARY_131060_RECOVERY_ACTIVATED_AT||"");
 if(!cutoff||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw))
   return "FALSE";
 const active=new Date(raw);
 if(!Number.isFinite(active.getTime()))return "FALSE";
 const since="'"+new Date(Math.max(new Date(cutoff).getTime(),active.getTime())).toISOString()+"'::timestamptz";
 const afterMenu=anchor?
   `AND ${anchor}.role='user'
       AND ${anchor}.whatsapp_message_id IS NOT NULL
       AND ${anchor}.source_created_at IS NOT NULL
       AND (
         (${anchor}.id>recovery_menu.id
          AND ${anchor}.created_at>=recovery_menu.created_at
          AND ${anchor}.created_at<recovery_menu.created_at+INTERVAL '7 days'
          AND ${anchor}.content NOT LIKE '📎 [% sent a WhatsApp message that could not be displayed]')
         OR
         -- The original unreadable inbound can anchor only its verified,
         -- provider-accepted text-only recovery reminders. No treatment,
         -- ad attribution, marketing consent or artificial customer turn.
         (${anchor}.id=unavailable131060.id
          AND ${anchor}.content LIKE '📎 [% sent a WhatsApp message that could not be displayed]'
          AND recovery_menu.created_at<${anchor}.created_at+INTERVAL '24 hours')
       )`:
   `AND NOW()>=recovery_menu.created_at
       AND NOW()<recovery_menu.created_at+INTERVAL '7 days'`;
 return `EXISTS (
   SELECT 1 FROM messages unavailable131060
   JOIN whatsapp_sender_message_context missing_ctx
     ON missing_ctx.message_id=unavailable131060.id
   JOIN whatsapp_sender_conversations recovery_conv
     ON recovery_conv.id=missing_ctx.conversation_id
     AND recovery_conv.contact_id=${contact}.id
     AND recovery_conv.sender_id=${contact}.whatsapp_sender_id
     AND recovery_conv.customer_wa_id=${contact}.whatsapp_number
     AND recovery_conv.state='bound'
   JOIN messages recovery_menu
     ON recovery_menu.contact_id=${contact}.id
     AND recovery_menu.role='assistant'
     AND recovery_menu.whatsapp_message_id IS NOT NULL
     -- Initial Meta acceptance is insufficient after a failed delivery
     -- callback. A recovered old contact needs a usable menu receipt.
     AND recovery_menu.delivery_status IN ('sent','delivered','read')
     AND recovery_menu.created_at>=unavailable131060.created_at
     AND recovery_menu.content LIKE 'Hi～欢迎来到 Neutro Sense 😊%'
     AND recovery_menu.content LIKE '%可以点下面的选项%'
   JOIN whatsapp_sender_message_context recovery_ctx
     ON recovery_ctx.message_id=recovery_menu.id
     AND recovery_ctx.conversation_id=recovery_conv.id
   JOIN outbound_message_evidence accepted_menu
     ON accepted_menu.message_id=recovery_menu.id
     AND accepted_menu.contact_id=${contact}.id
     AND accepted_menu.channel='whatsapp'
     AND accepted_menu.origin='system_fallback'
     AND accepted_menu.accepted=TRUE
     AND accepted_menu.provider_message_id=recovery_menu.whatsapp_message_id
   WHERE unavailable131060.contact_id=${contact}.id
     AND unavailable131060.role='user'
     AND unavailable131060.whatsapp_message_id IS NOT NULL
     AND unavailable131060.content LIKE '📎 [% sent a WhatsApp message that could not be displayed]'
     AND unavailable131060.source_created_at>=${since}
     AND unavailable131060.created_at>=${since}
     -- An unrelated accepted menu after an older unsupported message
     -- must not turn that message into a reminder anchor.
     AND NOT EXISTS (
       SELECT 1 FROM messages intervening
       WHERE intervening.contact_id=${contact}.id
         AND intervening.id>unavailable131060.id
         AND intervening.id<recovery_menu.id
         AND (intervening.role='user' OR
              (intervening.role='assistant'
               AND intervening.sent_by_username IS NOT NULL))
     )
     AND NOT EXISTS(
       SELECT 1 FROM whatsapp_sender_coexistence_history_messages imported
       WHERE imported.message_id=unavailable131060.id
     )
     AND (
       EXISTS (
         SELECT 1 FROM inbound_processing_jobs recorded131060
         WHERE recorded131060.message_id=unavailable131060.id
           AND recorded131060.channel='whatsapp'
           AND recorded131060.incoming_payload->>'unsupportedType'='unsupported'
           AND recorded131060.incoming_payload->'unsupportedErrors'
               @> '[{"code":131060}]'::jsonb
       )
       OR (
         NOT EXISTS (
           SELECT 1 FROM inbound_processing_jobs pruned_job
           WHERE pruned_job.message_id=unavailable131060.id
         )
         -- The exact accepted recovery menu supplies durable evidence after
         -- inbound processing jobs and provider webhook payloads are pruned.
       )
     )
     ${afterMenu}
 )`;
}

module.exports={secondaryLegacyStaffCutoff,secondaryLegacyStaffAudienceSql,secondary131060RecoveryAudienceSql};
