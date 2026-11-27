"use strict";
// Explicit sender-specific opt-in. Meta still charges normally. This setting
// removes local billing authorization, holds, alarms and settlement from sending;
// it never grants WhatsApp consent or permits replay of an ambiguous send.
function deliveryOnlyEnabled(env=process.env){
 return env.WHATSAPP_SECONDARY_SENDER_KEY==="neutro_secondary" &&
   env.WHATSAPP_SECONDARY_DELIVERY_ONLY==="true";
}
function deliveryOnlySql(env=process.env){return deliveryOnlyEnabled(env)?"TRUE":"FALSE";}
function deliveryOnlyAttentionSql(alias="c",env=process.env){
 if(!/^[a-z][a-z0-9_]*$/i.test(alias))throw Error("Invalid contact alias");
 if(!deliveryOnlyEnabled(env))return "FALSE";
 return `(${alias}.mode='ai' AND ${alias}.takeover_by IS NULL
   AND ${alias}.whatsapp_opt_out_at IS NULL
   AND EXISTS(SELECT 1 FROM whatsapp_sender_accounts sa
     WHERE sa.id=${alias}.whatsapp_sender_id AND sa.sender_key='neutro_secondary' AND sa.state='active')
   AND (${alias}.attention_reason LIKE 'Delivery failed:%'
        OR ${alias}.attention_reason LIKE 'Delivery unconfirmed:%')
   AND EXISTS(SELECT 1 FROM messages m WHERE m.id=${alias}.delivery_attention_message_id
      AND m.contact_id=${alias}.id AND m.role='assistant')
   AND NOT EXISTS(SELECT 1 FROM ai_review_items r WHERE r.contact_id=${alias}.id AND r.status='pending'))`;
}
module.exports={deliveryOnlyEnabled,deliveryOnlySql,deliveryOnlyAttentionSql};
