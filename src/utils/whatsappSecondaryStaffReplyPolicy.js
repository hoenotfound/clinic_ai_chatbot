"use strict";
// Staff-authored replies remain bound to the secondary sender and the original
// customer-service window. A deleted/imported/forwarded/stale reply never
// authorizes a follow-up or modifies marketing consent.
function verifiedStaffReplySql(alias="reply",sender="sa"){
 for(const name of [alias,sender])if(!/^[a-z][a-z0-9_]*$/.test(name))throw new Error("Invalid SQL alias");
 return `(
  ${alias}.sent_by_username IS NOT NULL
  AND ${alias}.sent_by_username <> 'Follow-up automation'
  AND ${alias}.whatsapp_message_id IS NOT NULL
  AND ${alias}.delivery_status IS DISTINCT FROM 'failed'
  AND ${alias}.is_automated_follow_up IS DISTINCT FROM TRUE
  AND COALESCE(${alias}.whatsapp_customer_mutation,'')=''
  AND COALESCE(${alias}.is_forwarded,FALSE)=FALSE
  AND NULLIF(BTRIM(${alias}.content),'') IS NOT NULL
  AND ${alias}.content NOT LIKE '🗑️ %'
  AND ${alias}.content NOT LIKE '[media_placeholder%'
  AND ${alias}.content NOT LIKE '📎 [Customer sent%'
  AND NOT EXISTS (
    SELECT 1 FROM whatsapp_sender_coexistence_history_messages imported_staff
    WHERE imported_staff.sender_id=${sender}.id
      AND imported_staff.message_id=${alias}.id
  )
)`;
}

function staffQuestionSql(alias){
 return `(COALESCE(${alias}.content,'') ~ '[?？]'
 OR COALESCE(${alias}.content,'') ~* '(请问|請問|想问|想問|能否告诉|能否告訴|could you|can you tell|boleh beritahu)')`;
}

function staffPendingSql(alias){
 return `COALESCE(${alias}.content,'') ~* '(我(再|会|會|帮|幫)(去)?(查|确认|確認|回复|回覆|联系|聯繫)|等我(们|們)?(查|确认|確認|回复|回覆)|稍后(回复|回覆)|查好(再|后|後)|let me (check|confirm|verify)|i( will|.ll) (check|confirm|get back)|we( will|.ll) (check|confirm|get back)|waiting for (staff|doctor)|saya (semak|akan semak)|kami (semak|akan semak))'`;
}

function serviceReplyAnchorSql(){
 return `
 JOIN LATERAL (
  SELECT reply.id,reply.created_at AS at,reply.content AS text,
    (reply.sent_by_username IS NOT NULL) AS staff_reply,
    (reply.sent_by_username IS NOT NULL AND ${staffQuestionSql("reply")}) AS staff_question,
    (reply.sent_by_username IS NOT NULL AND ${staffPendingSql("reply")}) AS staff_pending_action
  FROM messages reply
  JOIN whatsapp_sender_message_context reply_context
    ON reply_context.message_id=reply.id AND reply_context.conversation_id=sc.id
  WHERE reply.contact_id=c.id AND reply.role='assistant'
    AND reply.whatsapp_message_id IS NOT NULL
    AND reply.created_at>=inbound.created_at
    AND reply.created_at<inbound.created_at+INTERVAL '24 hours'
    AND ((
      reply.sent_by_username IS NULL
      AND reply.is_automated_follow_up IS DISTINCT FROM TRUE
    ) OR ${verifiedStaffReplySql("reply","sa")})
  ORDER BY (reply.sent_by_username IS NOT NULL) DESC,
    CASE WHEN reply.sent_by_username IS NOT NULL THEN reply.created_at END DESC,
    CASE WHEN reply.sent_by_username IS NULL THEN reply.created_at END ASC,
    reply.id DESC LIMIT 1
 ) first_reply ON TRUE
`;
}

function marketingReplyAnchorSql(){
 return `
 JOIN LATERAL (
  SELECT reply.id,reply.created_at AS at,reply.content AS text
  FROM messages reply
  JOIN whatsapp_sender_message_context reply_context
    ON reply_context.message_id=reply.id AND reply_context.conversation_id=sc.id
  WHERE reply.contact_id=c.id AND reply.role='assistant'
    AND reply.whatsapp_message_id IS NOT NULL
    AND ((
      reply.sent_by_username IS NULL
      AND reply.is_automated_follow_up IS DISTINCT FROM TRUE
      AND reply.created_at>=CASE WHEN $7::text='all_contacts'
        AND NOT recent_contact.legacy_ads_eligible
        THEN inbound.created_at ELSE c.created_at END
      AND reply.created_at<(CASE WHEN $7::text='all_contacts'
        AND NOT recent_contact.legacy_ads_eligible
        THEN inbound.created_at ELSE c.created_at END)+INTERVAL '24 hours'
    ) OR (
      ${verifiedStaffReplySql("reply","sa")}
      AND reply.created_at>=inbound.created_at
      AND reply.created_at<inbound.created_at+INTERVAL '24 hours'
    ))
  ORDER BY (reply.sent_by_username IS NOT NULL) DESC,
    CASE WHEN reply.sent_by_username IS NOT NULL THEN reply.created_at END DESC,
    CASE WHEN reply.sent_by_username IS NULL THEN reply.created_at END ASC,
    reply.id DESC LIMIT 1
 ) first_reply ON TRUE
`;
}

function latestUnresolvedStaffSql(){
 return `EXISTS (
  SELECT 1 FROM (
    SELECT staff.content
    FROM messages staff
    JOIN whatsapp_sender_message_context staff_context
      ON staff_context.message_id=staff.id AND staff_context.conversation_id=sc.id
    WHERE staff.contact_id=c.id AND staff.role='assistant'
      AND staff.created_at>=inbound.created_at
      AND ${verifiedStaffReplySql("staff","sa")}
    ORDER BY staff.created_at DESC,staff.id DESC LIMIT 1
  ) last_staff WHERE ${staffQuestionSql("last_staff")} OR ${staffPendingSql("last_staff")}
)`;
}

function recentStaffReplySql(nowSql="$4::timestamptz"){
 return `EXISTS (
  SELECT 1 FROM messages staff
  JOIN whatsapp_sender_message_context staff_context
    ON staff_context.message_id=staff.id AND staff_context.conversation_id=sc.id
  WHERE staff.contact_id=c.id AND staff.role='assistant'
    AND staff.created_at>=inbound.created_at
    AND staff.created_at>${nowSql}-INTERVAL '24 hours'
    AND ${verifiedStaffReplySql("staff","sa")}
)`;
}

function gentleStaffQuestionNudge(language){
 if(language==="zh")return "关于刚才的问题，有空时回复我们就好哦 😊 我们会先了解您的情况，再请中医师评估适合的护理。";
 if(language==="ms")return "Bila senang, boleh balas soalan kami tadi ya 😊 Kami akan fahami keadaan anda dahulu sebelum pengamal TCM menilai rawatan yang sesuai.";
 if(language==="en")return "Whenever convenient, feel free to reply to our earlier question 😊 We’ll understand your situation first before the TCM practitioner assesses suitable care.";
 return null;
}

module.exports={verifiedStaffReplySql,staffQuestionSql,staffPendingSql,
 serviceReplyAnchorSql,marketingReplyAnchorSql,latestUnresolvedStaffSql,
 recentStaffReplySql,gentleStaffQuestionNudge};
