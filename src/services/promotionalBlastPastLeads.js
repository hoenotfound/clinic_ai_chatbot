"use strict";
const {deliveryOnlySql}=require("../utils/whatsappSecondaryDeliveryOnly");

// A separate audience is important: the existing CTWA blast retains every
// verified free-entry condition. Past leads require actual marketing permission
// and a new, paid, approved MARKETING template.
const PAST_LEAD_CANDIDATE_SQL=String.raw`
WITH campaign AS (
  SELECT campaign_key,template_name,title,promoted_treatment,target_treatments,
         valid_until,package_name
  FROM whatsapp_promotional_blast_campaigns
  WHERE campaign_key=$1 AND enabled AND valid_until>now()
    AND audience_mode='past_leads' AND package_name IS NOT NULL
),configured_package AS (
  SELECT option->>'imageUrl' AS image_url
  FROM campaign
  JOIN clinic_config config ON config.id=1
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(config.data->'promotions','[]'::jsonb)) promo
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(promo->'packages','[]'::jsonb)) option
  WHERE promo->>'linkedService'=campaign.promoted_treatment
    AND option->>'name'=campaign.package_name
    AND promo->>'sendOnPriceQuery'='true'
    AND COALESCE(promo->>'validFrom','0000-01-01') <= to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY-MM-DD')
    AND COALESCE(promo->>'validUntil','9999-12-31') >= to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY-MM-DD')
    AND option->>'imageUrl' ~ '^https://[^ ]+/promo-images/[0-9]+$'
),recoverable_unsent AS (
  SELECT message.id
  FROM messages message
  JOIN whatsapp_promotional_blast_claims claim
    ON claim.contact_id=message.contact_id
   AND claim.campaign_key=$1 AND claim.state='reserved'
   AND claim.attempted_at IS NULL
  JOIN contacts recipient
    ON recipient.id=message.contact_id
   AND recipient.whatsapp_sender_id=claim.sender_id
   AND regexp_replace(recipient.whatsapp_number,'[^0-9]','','g')=claim.recipient_key
  JOIN campaign promo ON promo.campaign_key=claim.campaign_key
  WHERE message.role='assistant'
    AND message.whatsapp_template->>'blastCampaignKey'=promo.campaign_key
    AND message.whatsapp_message_id IS NULL
    AND message.delivery_status='failed'
),active_leads AS (
  SELECT DISTINCT ON (l.contact_id)
    l.contact_id,l.treatment_interest,l.marketing_consent,l.is_closed,
    l.appointment_status,l.stage_id
  FROM leads l
  JOIN contacts c ON c.id=l.contact_id
  CROSS JOIN campaign
  WHERE c.channel='whatsapp' AND c.whatsapp_sender_id IN (1,2)
    AND l.treatment_interest=campaign.promoted_treatment
    AND l.appointment_status='none' AND l.is_closed IS FALSE
  ORDER BY l.contact_id,l.created_at DESC,l.id DESC
),candidates AS (
  SELECT c.id AS contact_id,c.whatsapp_sender_id AS sender_id,
    regexp_replace(c.whatsapp_number,'[^0-9]','','g') AS recipient_key,
    COALESCE(NULLIF(c.whatsapp_profile_name,''),NULLIF(c.name,''),'Contact '||c.id) AS contact_name,
    l.treatment_interest,FALSE AS related_offer_review_required,
    campaign.campaign_key,campaign.template_name,
    inbound.created_at AS first_reply_at,
    LEAST(campaign.valid_until,now()+interval '20 minutes') AS safe_expires_at,
    CASE WHEN inbound.content ~ '[一-龥]' THEN 'zh_CN'
         WHEN lower(coalesce(inbound.content,'')) ~ '(boleh|berapa|rawatan|nak |saya |harga)' THEN 'ms'
         ELSE 'en_US' END AS suggested_language,
    CASE WHEN NOT ${deliveryOnlySql()} AND c.whatsapp_sender_id=2 AND EXISTS (
      SELECT 1 FROM whatsapp_sender_billing_alarms alarm WHERE alarm.sender_id=2
    ) THEN 'secondary_billing_alarm'
    WHEN NOT ${deliveryOnlySql()} AND c.whatsapp_sender_id=2 AND EXISTS (
      SELECT 1 FROM whatsapp_sender_billing_gates gate
      WHERE gate.sender_id=c.whatsapp_sender_id
        AND gate.owner_contact_id=c.id AND gate.contact_id=c.id AND gate.state<>'idle'
    ) THEN 'secondary_billing_unresolved'
    ELSE NULL END AS blocked_reason
  FROM active_leads l
  JOIN contacts c ON c.id=l.contact_id
  JOIN whatsapp_sender_accounts sender ON sender.id=c.whatsapp_sender_id AND sender.state='active'
  CROSS JOIN campaign
  JOIN configured_package package ON TRUE
  LEFT JOIN pipeline_stages stage ON stage.id=l.stage_id
  JOIN LATERAL (
    SELECT created_at,content FROM messages m
    WHERE m.contact_id=c.id AND m.role='user'
    ORDER BY m.created_at DESC,m.id DESC LIMIT 1
  ) inbound ON TRUE
  WHERE c.whatsapp_number ~ '^[+]?[0-9]{8,15}$'
    AND COALESCE(c.mode,'ai')<>'human' AND c.needs_attention IS FALSE
    AND c.whatsapp_opt_in_at IS NOT NULL
    AND NULLIF(BTRIM(c.whatsapp_opt_in_source),'') IS NOT NULL
    AND c.whatsapp_opt_out_at IS NULL AND c.whatsapp_marketing_opt_out_at IS NULL
    AND l.marketing_consent='opted_in' AND l.is_closed IS FALSE
    AND COALESCE(stage.stage_type,'open')='open'
    AND COALESCE(stage.system_key,'') NOT IN ('appointment_set','visited','confirmed','booked','completed')
    AND inbound.created_at<now()-interval '24 hours'
    AND inbound.created_at>now()-interval '120 days'
    -- Customer must have actually granted treatment-specific promotional
    -- permission in an identifiable inbound WhatsApp message. An ad click is
    -- not consent. Check the sender-bound evidence for the secondary account.
    AND EXISTS (
      SELECT 1 FROM whatsapp_marketing_consent_events e
      JOIN messages cm ON cm.id=e.message_id AND cm.contact_id=c.id
        AND cm.role='user' AND cm.whatsapp_message_id IS NOT NULL
      WHERE e.contact_id=c.id AND e.consent_category='MARKETING'
        AND e.consent_scope='treatment_followups_and_related_offers'
        AND e.consent_service=campaign.promoted_treatment
        AND e.consented_at>=c.whatsapp_opt_in_at
        AND (
          c.whatsapp_sender_id=1 OR EXISTS (
            SELECT 1 FROM whatsapp_sender_message_context consent_ctx
            JOIN whatsapp_sender_conversations sc
              ON sc.id=consent_ctx.conversation_id AND sc.contact_id=c.id
                AND sc.sender_id=c.whatsapp_sender_id AND sc.state='bound'
            WHERE consent_ctx.message_id=cm.id
          )
        )
    )
    -- No booking, completed visit or conversion, on this or any other lead
    -- record for the contact, including past stage transitions.
    AND NOT EXISTS (
      SELECT 1 FROM leads other
      WHERE other.contact_id=c.id AND (
        other.appointment_at IS NOT NULL
        OR COALESCE(other.appointment_status,'none')<>'none'
        OR other.stage_id IN (3,4,5)
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM lead_stage_history history
      JOIN leads other ON other.id=history.lead_id
      WHERE other.contact_id=c.id AND history.to_stage_id IN (3,4,5)
    )
    AND NOT EXISTS (
      SELECT 1 FROM messages booked
      WHERE booked.contact_id=c.id
        AND booked.content ~* '(已预约|已預約|预约成功|預約成功|已确认预约|已確認預約|appointment confirmed|booking confirmed|already booked|I booked|cancel my appointment)'
    )
    -- Respect refusal, disinterest, distance and any human handoff.
    AND NOT EXISTS (
      SELECT 1 FROM messages declined
      WHERE declined.contact_id=c.id AND declined.role='user'
        AND declined.created_at>now()-interval '120 days'
        AND COALESCE(declined.content,'') ~* '(stop promotions|unsubscribe|not interested|no thanks|too far|不考虑|不考慮|没兴趣|沒興趣|别再发|不要再发|退订|退訂|太远|太遠|有点远|有點遠|不需要|tak berminat|jangan hantar)'
    )
    AND NOT EXISTS (
      SELECT 1 FROM messages staff
      JOIN users u ON u.username=staff.sent_by_username
      WHERE staff.contact_id=c.id AND staff.role='assistant'
        AND staff.created_at>inbound.created_at
        AND NOT EXISTS (SELECT 1 FROM recoverable_unsent unsent WHERE unsent.id=staff.id)
    )
    AND NOT EXISTS (
      SELECT 1 FROM sales_follow_up_tasks handled
      JOIN leads related ON related.id=handled.lead_id
      WHERE related.contact_id=c.id AND handled.updated_at>=inbound.created_at
    )
    AND NOT EXISTS (
      SELECT 1 FROM messages outgoing
      WHERE outgoing.contact_id=c.id AND outgoing.role='assistant'
        AND outgoing.created_at>now()-interval '72 hours'
        AND outgoing.delivery_status IS DISTINCT FROM 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM recoverable_unsent unsent WHERE unsent.id=outgoing.id)
    )
    -- Do not resend either of the freshly updated pelvic graphics, including
    -- the replaced RM268 image 42, or the exact campaign template. Match
    -- numeric recipient across contact rows so another sender cannot bypass.
    AND NOT EXISTS (
      SELECT 1 FROM messages sent_promo
      JOIN contacts recipient ON recipient.id=sent_promo.contact_id
      WHERE recipient.whatsapp_number ~ '^[+]?[0-9]{8,15}$'
        AND regexp_replace(recipient.whatsapp_number,'[^0-9]','','g')=
            regexp_replace(c.whatsapp_number,'[^0-9]','','g')
        AND sent_promo.role='assistant'
        AND (
          sent_promo.whatsapp_template->>'blastCampaignKey'=campaign.campaign_key
          OR sent_promo.media_url=package.image_url
          OR (campaign.promoted_treatment='骨盆调理'
            AND sent_promo.media_url ~ '/promo-images/(41|42|43)([?#]|$)')
        )
        AND NOT EXISTS (SELECT 1 FROM recoverable_unsent unsent WHERE unsent.id=sent_promo.id)
    )
    AND now()<campaign.valid_until
    AND NOT EXISTS (
      SELECT 1 FROM clinic_config settings WHERE settings.id=1
        AND COALESCE(settings.data #>> '{automatedFollowUp,quietHours,enabled}','true')='true'
        AND (
          CASE WHEN COALESCE(settings.data #>> '{automatedFollowUp,quietHours,start}','00:00')
                 < COALESCE(settings.data #>> '{automatedFollowUp,quietHours,end}','07:00')
            THEN to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','HH24:MI')
                 >= COALESCE(settings.data #>> '{automatedFollowUp,quietHours,start}','00:00')
             AND to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','HH24:MI')
                 < COALESCE(settings.data #>> '{automatedFollowUp,quietHours,end}','07:00')
            ELSE to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','HH24:MI')
                 >= COALESCE(settings.data #>> '{automatedFollowUp,quietHours,start}','00:00')
              OR to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','HH24:MI')
                 < COALESCE(settings.data #>> '{automatedFollowUp,quietHours,end}','07:00')
          END
        )
    )
)
SELECT contact_id,sender_id,recipient_key,contact_name,treatment_interest,
       related_offer_review_required,campaign_key,template_name,
       first_reply_at,safe_expires_at,suggested_language,blocked_reason
FROM candidates`;
module.exports={PAST_LEAD_CANDIDATE_SQL};
