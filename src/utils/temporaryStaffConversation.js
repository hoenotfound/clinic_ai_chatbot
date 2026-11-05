"use strict";
// Reused by live reply handling and every sender's follow-up send checks.
// Brief staff-led appointment coordination is not the same as a broadcast
// greeting, promotion, media upload or historical staff chat.
function temporaryStaffConversationSql(contact="c",inbound="inbound"){
 for(const alias of [contact,inbound]){
  if(!/^[a-z][a-z0-9_]*$/iu.test(alias))throw new TypeError("Invalid SQL alias");
 }
 return `EXISTS (
  SELECT 1 FROM messages staff
  WHERE staff.contact_id=${contact}.id
    AND staff.role='assistant'
    AND staff.sent_by_username IS NOT NULL
    AND staff.sent_by_username<>'Follow-up automation'
    AND staff.whatsapp_message_id IS NOT NULL
    AND staff.is_automated_follow_up IS DISTINCT FROM TRUE
    AND staff.delivery_status IS DISTINCT FROM 'failed'
    AND (staff.created_at,staff.id)<(${inbound}.created_at,${inbound}.id)
    AND staff.created_at>=${inbound}.created_at-INTERVAL '2 hours'
    AND (staff.media_mime_type IS NULL OR staff.media_mime_type NOT LIKE 'image/%')
    AND COALESCE(staff.content,'') !~* '(happy[[:space:]]+birthday|birthday|生日快乐|生日快樂|complimentary[[:space:]]+treat|本月限时优惠|本月限時優惠)'
    AND (
      COALESCE(staff.content,'') ~ '[?？]'
      OR COALESCE(staff.content,'') ~* '(confirm|comfirm|confirmed|booked|booking|appointment|预约|預約|确认|確認|已安排|slot|时段|時段|can[[:space:]]+[0-9]{1,2}([:.][0-9]{2})?[[:space:]]*(am|pm))'
    )
    AND EXISTS (
      SELECT 1 FROM messages previous_customer
      WHERE previous_customer.contact_id=staff.contact_id
        AND previous_customer.role='user'
        AND (previous_customer.created_at,previous_customer.id)<(staff.created_at,staff.id)
        AND previous_customer.created_at>=staff.created_at-INTERVAL '30 minutes'
    )
    AND NOT EXISTS (
      SELECT 1 FROM messages ai
      WHERE ai.contact_id=staff.contact_id AND ai.role='assistant'
        AND ai.sent_by_username IS NULL
        AND ai.is_automated_follow_up IS DISTINCT FROM TRUE
        AND (ai.created_at,ai.id)>(staff.created_at,staff.id)
        AND (ai.created_at,ai.id)<(${inbound}.created_at,${inbound}.id)
    )
 )`;
}
module.exports={temporaryStaffConversationSql};
