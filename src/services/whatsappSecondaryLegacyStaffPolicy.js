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
  )`;
}
module.exports={secondaryLegacyStaffCutoff,secondaryLegacyStaffAudienceSql};
