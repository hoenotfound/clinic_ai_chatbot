"use strict";

// Operator-approved, reservation-specific override. An unknown receipt,
// failed delivery, or 30-minute timeout alone is NOT review evidence.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function reviewedReservationIds(env=process.env){
 if(env?.WHATSAPP_SECONDARY_SENDER_KEY!=="neutro_secondary" ||
    env?.WHATSAPP_SECONDARY_UNKNOWN_GATE_NEW_SEND_BYPASS_ENABLED!=="true")return[];
 const raw=String(env.WHATSAPP_SECONDARY_REVIEWED_UNKNOWN_RESERVATIONS||"");
 if(!raw || raw.length>512)return[];
 const values=raw.split(",").map(s=>s.trim().toLowerCase());
 if(values.length>8 || values.some(s=>!UUID.test(s)) ||
    new Set(values).size!==values.length)return[];
 return values;
}
function reviewReservationSql(env=process.env,qualified="a.reservation_id"){
 const ids=reviewedReservationIds(env);
 return ids.length
   ? qualified+" IN ("+ids.map(id=>"'"+id+"'::uuid").join(",")+")"
   : "FALSE";
}

// A final signed failure on the exact sender+WAMID is conclusive evidence of
// delivery failure, not proof that Meta charged nothing. It may resume normal
// new-send eligibility without a manual review UUID, but never replay the
// failed message or bypass opt-out, takeover, fresh-inbound or billing checks.
function signedFailureOrReviewedSql(env=process.env,messageAlias="old_outbound"){
 if(!/^[a-z][a-z0-9_]*$/i.test(messageAlias))
   throw Error("Invalid message SQL alias");
 const review=reviewReservationSql(env,"held_attempt.reservation_id");
 if(env?.WHATSAPP_SECONDARY_SENDER_KEY!=="neutro_secondary")
   return review;
 return `(${review} OR (
   held_attempt.wamid IS NOT NULL
   AND ${messageAlias}.whatsapp_message_id=held_attempt.wamid
   AND ${messageAlias}.delivery_status='failed'
   AND EXISTS(
     SELECT 1 FROM whatsapp_sender_status_receipts verified_failure
     JOIN whatsapp_sender_accounts expected_sender
       ON expected_sender.id=held_attempt.sender_id
       AND expected_sender.sender_key='neutro_secondary'
     WHERE verified_failure.sender_id=held_attempt.sender_id
       AND verified_failure.reservation_id=held_attempt.reservation_id
       AND verified_failure.wamid=held_attempt.wamid
       AND verified_failure.matched=TRUE
       AND verified_failure.delivery_status='failed'
       AND verified_failure.meta_phone_number_id=expected_sender.meta_phone_number_id
       AND verified_failure.meta_account_id=expected_sender.meta_account_id
   )
 ))`;
}
// Fresh readable inbound still required to resume AI. No earlier message is
// replayed; the final transactional reservation enforces current sender rules.
function reviewedDeliveryAttentionSql(alias="c",env=process.env,anchorSql=null){
 if(!/^[a-z][a-z0-9_]*$/i.test(alias))throw Error("Invalid contact SQL alias");
 const approved=signedFailureOrReviewedSql(env,"old_outbound");
 if(approved==="FALSE")return "FALSE";
 // The original ad session cannot regain authority just because a DIFFERENT
 // later customer question arrived. Automated work must use that new anchor.
 if(anchorSql!==null && !/^(?:[a-z][a-z0-9_]*|\$[1-9][0-9]*)$/i.test(anchorSql))
   throw Error("Invalid message anchor SQL");
 const anchorCheck=anchorSql===null?"":" AND customer.id="+
   (/^\$/.test(anchorSql)?anchorSql:anchorSql+".id");
 return [
  "(",
  " {A}.mode='ai' AND {A}.needs_attention=TRUE",
  " AND {A}.takeover_by IS NULL AND {A}.whatsapp_opt_out_at IS NULL",
  " AND ({A}.attention_reason LIKE 'Delivery failed:%'",
  "      OR {A}.attention_reason LIKE 'Delivery unconfirmed:%')",
  " AND NOT EXISTS(SELECT 1 FROM ai_review_items review",
  "   WHERE review.contact_id={A}.id AND review.status='pending')",
  " AND EXISTS(",
  "  SELECT 1 FROM whatsapp_sender_billing_attempts held_attempt",
  "  JOIN messages old_outbound ON old_outbound.id=held_attempt.message_id",
  "   AND old_outbound.id={A}.delivery_attention_message_id",
  "   AND old_outbound.contact_id={A}.id AND old_outbound.role='assistant'",
  "   AND old_outbound.delivery_status IN ('failed','unknown')",
  "  WHERE held_attempt.sender_id={A}.whatsapp_sender_id",
  "    AND held_attempt.contact_id={A}.id AND held_attempt.state='unknown'",
  "    AND {APPROVED}",
  "    AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_billing_alarms alarm",
  "      WHERE alarm.sender_id=held_attempt.sender_id)",
  "    AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_status_receipts receipt",
  "      WHERE receipt.sender_id=held_attempt.sender_id",
  "        AND receipt.reservation_id=held_attempt.reservation_id",
  "        AND (receipt.delivery_status IN ('delivered','read')",
  "             OR receipt.pricing_billable=TRUE))",
  "    AND EXISTS(SELECT 1 FROM whatsapp_sender_billing_gates current_gate",
  "      WHERE current_gate.sender_id=held_attempt.sender_id",
  "        AND current_gate.owner_contact_id={A}.id",
  "        AND ((",
  "          current_gate.state='unknown'",
  "          AND current_gate.reservation_id=held_attempt.reservation_id",
  "          AND current_gate.contact_id={A}.id",
  "          AND current_gate.message_id=old_outbound.id",
  "          AND current_gate.updated_at<=NOW()-INTERVAL '30 minutes'",
  "          AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_unknown_gate_new_sends older",
  "            WHERE older.sender_id=held_attempt.sender_id",
  "              AND older.contact_id={A}.id",
  "              AND older.reopened_at>NOW()-INTERVAL '30 days')",
  "        ) OR (",
  "          current_gate.state='idle'",
  "          AND EXISTS(SELECT 1 FROM whatsapp_sender_unknown_gate_new_sends approved_bypass",
  "            WHERE approved_bypass.old_reservation_id=held_attempt.reservation_id",
  "              AND approved_bypass.sender_id=held_attempt.sender_id",
  "              AND approved_bypass.contact_id={A}.id",
  "              AND approved_bypass.old_message_id=old_outbound.id)",
  "        ))",
  "    )",
  "    AND EXISTS(",
  "      SELECT 1 FROM whatsapp_sender_conversations sc",
  "      JOIN messages customer ON customer.contact_id={A}.id",
  "        AND customer.role='user' AND customer.whatsapp_message_id IS NOT NULL",
  "        AND customer.source_created_at IS NOT NULL",
  "        AND customer.source_created_at>old_outbound.created_at",
  "        AND customer.created_at>old_outbound.created_at",
  "        AND customer.is_forwarded IS DISTINCT FROM TRUE",
  "        {ANCHOR}",
  "        AND NULLIF(BTRIM(COALESCE(customer.content,'')),'') IS NOT NULL",
  "        AND customer.content NOT LIKE '📎 [%'",
  "      JOIN whatsapp_sender_message_context mc",
  "        ON mc.message_id=customer.id AND mc.conversation_id=sc.id",
  "      WHERE sc.sender_id=held_attempt.sender_id AND sc.contact_id={A}.id",
  "        AND sc.customer_wa_id={A}.whatsapp_number AND sc.state='bound'",
  "    )",
  " )",
  ")"
 ].join("\n").replaceAll("{A}",alias).replace("{APPROVED}",approved)
   .replace("{ANCHOR}",anchorCheck);
}
// Discovery-time check only. The final send uses the stronger transactional
// reservation and provider evidence checks. Refuse unreviewed UNKNOWN gates
// before inserting a one-shot marketing attempt or issuing a template.
function reviewedUnknownGateCandidateSql(contactAlias="c",senderAlias="sa",env=process.env){
 for(const alias of [contactAlias,senderAlias]){
  if(!/^[a-z][a-z0-9_]*$/i.test(alias))throw Error("Invalid SQL alias");
 }
 const approved=signedFailureOrReviewedSql(env,"failed_video");
 return `NOT EXISTS (
   SELECT 1 FROM whatsapp_sender_billing_gates preflight_gate
   WHERE preflight_gate.sender_id=${senderAlias}.id
     AND preflight_gate.owner_contact_id=${contactAlias}.id
     AND preflight_gate.state='unknown'
     AND NOT EXISTS (
       SELECT 1 FROM whatsapp_sender_billing_attempts held_attempt
       JOIN messages failed_video ON failed_video.id=held_attempt.message_id
         AND failed_video.contact_id=held_attempt.contact_id
         AND failed_video.role='assistant'
       WHERE held_attempt.reservation_id=preflight_gate.reservation_id
         AND held_attempt.sender_id=preflight_gate.sender_id
         AND held_attempt.contact_id=${contactAlias}.id
         AND held_attempt.message_id=preflight_gate.message_id
         AND preflight_gate.contact_id=${contactAlias}.id
         AND held_attempt.state='unknown'
         AND ${approved}
         AND preflight_gate.updated_at<=NOW()-INTERVAL '30 minutes'
         AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_unknown_gate_new_sends previous
           WHERE previous.sender_id=held_attempt.sender_id
             AND previous.contact_id=held_attempt.contact_id
             AND previous.reopened_at>NOW()-INTERVAL '30 days')
         AND NOT EXISTS (SELECT 1 FROM whatsapp_sender_status_receipts success
           WHERE success.sender_id=held_attempt.sender_id
             AND success.reservation_id=held_attempt.reservation_id
             AND (success.delivery_status IN('delivered','read')
                  OR success.pricing_billable=TRUE))
         AND (
           (held_attempt.wamid IS NULL
             AND failed_video.whatsapp_message_id IS NULL
             AND failed_video.delivery_status='unknown'
             AND NOT EXISTS (SELECT 1 FROM whatsapp_sender_status_receipts any_receipt
               WHERE any_receipt.sender_id=held_attempt.sender_id
                 AND any_receipt.reservation_id=held_attempt.reservation_id))
           OR
           (held_attempt.wamid IS NOT NULL
             AND failed_video.whatsapp_message_id=held_attempt.wamid
             AND failed_video.delivery_status='failed'
             AND EXISTS (SELECT 1 FROM whatsapp_sender_status_receipts signed_failure
               WHERE signed_failure.sender_id=held_attempt.sender_id
                 AND signed_failure.reservation_id=held_attempt.reservation_id
                 AND signed_failure.wamid=held_attempt.wamid
                 AND signed_failure.matched=TRUE
                 AND signed_failure.delivery_status='failed'
                 AND signed_failure.meta_phone_number_id=${senderAlias}.meta_phone_number_id
                 AND signed_failure.meta_account_id=${senderAlias}.meta_account_id))
         )
     )
 )`;
}
module.exports={reviewedReservationIds,reviewReservationSql,reviewedDeliveryAttentionSql,reviewedUnknownGateCandidateSql};
