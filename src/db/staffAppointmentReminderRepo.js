"use strict";
// Shared, sender-verified, idempotent reminder signals; use only inside a
// transaction holding the contact-level advisory lock.
const HOLD_SQL=`
        INSERT INTO lead_activities(lead_id,activity_type,description,actor,metadata)
        SELECT lead.id,'updated','Verified staff appointment reminder; sales follow-ups on hold.',
               'Automation',jsonb_build_object('outcome','staff_appointment_reminder',
                 'staffMessageId',staff.id,'source','verified_staff_send')
        FROM messages staff
        JOIN LATERAL (
          SELECT l.id FROM leads l
          WHERE l.contact_id=staff.contact_id AND l.is_closed=false
            AND COALESCE(l.appointment_status,'none') NOT IN ('set','visited','cancelled')
            -- Do not attach an old staff replay to a newly-created lead.
            AND l.created_at<=staff.created_at + INTERVAL '30 minutes'
          ORDER BY l.created_at DESC,l.id DESC LIMIT 1
        ) lead ON true
        WHERE staff.id=$2 AND staff.contact_id=$1 AND staff.role='assistant'
          AND staff.whatsapp_message_id IS NOT NULL
          AND staff.is_forwarded IS DISTINCT FROM TRUE
          AND staff.media_mime_type IS NULL
          AND staff.is_automated_follow_up IS DISTINCT FROM TRUE
          AND staff.sent_by_username IS NOT NULL
          AND staff.sent_by_username NOT IN
            ('Follow-up automation','Consent request automation')
          AND staff.delivery_status IS DISTINCT FROM 'failed'
          AND staff.created_at>=NOW()-INTERVAL '7 days'
          AND BTRIM(staff.content)=BTRIM($3)
          AND NOT EXISTS(
            SELECT 1 FROM lead_activities prior
            WHERE prior.lead_id=lead.id
              AND prior.metadata->>'outcome'='staff_appointment_reminder'
              AND prior.metadata->>'staffMessageId'=staff.id::text
              AND NOT EXISTS (
                SELECT 1 FROM lead_activities invalidated
                WHERE invalidated.lead_id=lead.id
                  AND invalidated.metadata->>'outcome'='staff_reminder_invalidated'
                  AND invalidated.metadata->>'staffMessageId'=staff.id::text
                  AND invalidated.id>prior.id
              )
          )
        RETURNING id
      `;
const INVALIDATE_SQL=`
  INSERT INTO lead_activities(lead_id,activity_type,description,actor,metadata)
  SELECT reminder.lead_id,'updated','Staff edited or deleted appointment reminder; automated sales hold invalidated.',
         'Automation',jsonb_build_object('outcome','staff_reminder_invalidated',
           'staffMessageId',$2::bigint,'mutationId',$3::bigint)
  FROM lead_activities reminder
  JOIN leads lead ON lead.id=reminder.lead_id AND lead.contact_id=$1
  WHERE reminder.metadata->>'outcome'='staff_appointment_reminder'
    AND reminder.metadata->>'staffMessageId'=$2::text
    AND NOT EXISTS (
      SELECT 1 FROM lead_activities newer_hold
      WHERE newer_hold.lead_id=reminder.lead_id
        AND newer_hold.metadata->>'outcome'='staff_appointment_reminder'
        AND newer_hold.metadata->>'staffMessageId'=$2::text
        AND newer_hold.id>reminder.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM lead_activities prior_invalidation
      WHERE prior_invalidation.lead_id=reminder.lead_id
        AND prior_invalidation.metadata->>'outcome'='staff_reminder_invalidated'
        AND prior_invalidation.metadata->>'staffMessageId'=$2::text
        AND prior_invalidation.id>reminder.id
    )
  LIMIT 1
`;
module.exports={HOLD_SQL,INVALIDATE_SQL};
