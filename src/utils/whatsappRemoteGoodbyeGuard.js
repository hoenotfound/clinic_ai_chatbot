"use strict";

// A verified AI goodbye to a remote customer closes the present enquiry, not
// every future one. A NEW readable, sender-bound inbound can reopen the chat.
// All clauses are restricted to one exact WhatsApp sender conversation.
// SQL aliases are hardcoded in callers; no customer input is interpolated.
function remoteConversationGoodbyeSql() {
 return String.raw`
 AND NOT EXISTS(
   SELECT 1 FROM messages closing_reply
   JOIN whatsapp_sender_message_context closing_context
     ON closing_context.message_id=closing_reply.id
     AND closing_context.conversation_id=sc.id
   WHERE closing_reply.contact_id=c.id AND closing_reply.role='assistant'
     AND closing_reply.sent_by_username IS NULL
     AND closing_reply.whatsapp_message_id IS NOT NULL
     AND closing_reply.delivery_status IN ('sent','delivered','read')
     AND (closing_reply.created_at,closing_reply.id)>(inbound.created_at,inbound.id)
     AND COALESCE(closing_reply.content,'') ~*
       '(柔佛|新山|johor|[[:<:]]jb[[:>:]]|一段距离|一段距離|too[[:space:]]+far)'
     AND COALESCE(closing_reply.content,'') ~*
       '(祝(你|您)(顺心|順心|愉快)|take[[:space:]]+care|semoga[[:space:]]+)'
     AND NOT EXISTS(
       SELECT 1 FROM messages new_enquiry
       JOIN whatsapp_sender_message_context new_context
         ON new_context.message_id=new_enquiry.id
         AND new_context.conversation_id=sc.id
       WHERE new_enquiry.contact_id=c.id AND new_enquiry.role='user'
         AND new_enquiry.whatsapp_message_id IS NOT NULL
         AND COALESCE(new_enquiry.content,'') NOT LIKE
           '📎 [%sent a WhatsApp message that could not be displayed]'
         AND (new_enquiry.created_at,new_enquiry.id)>
             (closing_reply.created_at,closing_reply.id)
         AND NOT EXISTS(
           SELECT 1 FROM whatsapp_sender_coexistence_history_messages imported
           WHERE imported.sender_id=sa.id AND imported.message_id=new_enquiry.id
         )
     )
 )
 `;
}
module.exports={remoteConversationGoodbyeSql};
