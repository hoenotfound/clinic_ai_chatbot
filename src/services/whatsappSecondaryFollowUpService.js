"use strict";

// Independent, opt-in-only sender follow-ups. These messages never enter
// Neutro's follow-up queue, template billing or retry worker.
// Its media upload cache may be reused only with the distinct secondary phone ID.
// A claimed slot is one-shot even after timeout, worker crash or uncertain
// provider acceptance. Nothing sends while either flag or rules are disabled.
const {pool}=require("../db/db");
const {invitation:generalSixDayInvitation}=require("../utils/neutroGeneralFollowupConsent");
const generalSixDay=require("./neutroSecondaryGeneralMarketingSql");
const {temporaryStaffConversationSql}=require('../utils/temporaryStaffConversation');
const {serviceReplyAnchorSql,gentleStaffQuestionNudge}=require("../utils/whatsappSecondaryStaffReplyPolicy");
const {pendingCancellationFollowupAllowedSql}=require("../utils/appointmentCancellationSafety");
const messagesRepo=require("../db/messagesRepo");
const contactsRepo=require("../db/contactsRepo");
const mediaStorage=require("./mediaStorageService");
const {secondaryVideoCacheEligible,dispatchSecondaryFollowUpVideo}=require("./whatsappSecondaryVideoCache");
const configRepo=require("../db/configRepo");
const {isCurrentApprovedFollowUpVideo,selectApprovedTreatmentVideo}=require("./whatsappSecondaryFollowUpVideoApproval");
const {localizedFollowUpText,resolveFollowUpTreatment}=require("./whatsappSecondaryFollowUpLanguage");
const {classifyVerifiedTreatmentTurn,isStoppedDecision,
  chooseSecondaryFollowUpTreatment,DISTANCE_OBJECTION_SQL}=
  require("./whatsappSecondaryFollowUpDecision");
const {resolveAdFollowUpTreatment,neutralMixedAdFollowUp}=
  require("../utils/adFollowUpTreatment");
const {detectConversationLanguage}=require("../utils/chatLanguage");
const {sendSecondaryStaffText}=require("./whatsappSecondaryStaffDispatch");
const {createPersonalized20h}=require("./whatsappSecondaryPersonalizedFollowUp");
const {secondaryAutomationActivation,secondaryAutomationEligibleSql,
  reviewedContactFollowupGuardSql,originalAdsOnlyCutoff,secondaryAutomationAttentionAllowedSql }=require("./whatsappSecondaryAdsOnlyEligibility");
const { pendingAcceptedAppointmentAllowedSql }=require("../utils/pendingAcceptedAppointmentFollowUp");
const realtimeEvents=require("../utils/realtimeEvents");
const {deriveSecondaryPotentialDueSql,createSecondaryDueScheduler}=
  require("../utils/secondaryDueTimeScheduler");

// Primary-parity 24h service follow-ups are separate from opted-in marketing.
// Newly included contacts must initiate a fresh provider-timestamped chat.
function serviceFollowupParityActivation(env=process.env) {
  if(env.WHATSAPP_SECONDARY_SENDER_KEY!=="neutro_secondary" ||
     env.WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE!=="all_contacts")return null;
  const automationCutoff=secondaryAutomationActivation(env);
  const raw=String(env.WHATSAPP_SECONDARY_SERVICE_FOLLOWUP_PARITY_ACTIVATED_AT||"");
  if(!automationCutoff ||
     !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw))return null;
  const ms=Date.parse(raw);
  return Number.isFinite(ms) && ms>=Date.parse(automationCutoff)
    ? new Date(ms).toISOString() : null;
}

const SLOTS=new Set([2,6,20]);
const MAX_MEDIA=16*1024*1024;
const SLOW_QUERY_WARNING_MS=3000;
// Report only materially slow SQL; never log contact IDs, message bodies,
// bound parameters or provider identifiers. Does not change retry behaviour.
async function monitoredFollowUpRead(database,sql,params,label){
 const started=performance.now();
 try{return await database.query(sql,params);}
 finally {
   const elapsedMs=Math.round(performance.now()-started);
   if(elapsedMs>=SLOW_QUERY_WARNING_MS)
     console.warn("[Secondary WhatsApp follow-ups] slow "+label+" query:",elapsedMs+"ms");
 }
}
const ALLOWED_MIME={
  video:new Set(["video/mp4","video/3gpp"]),
  image:new Set(["image/jpeg","image/png"]),
  audio:new Set(["audio/ogg","audio/mpeg","audio/mp4","audio/aac"]),
};

// Treat a verified staff answer as a potential service follow-up anchor.
// Imported, forwarded and deleted messages are excluded in the shared policy.
const FIRST_REPLY_SQL=serviceReplyAnchorSql();
// FU3 remains four hours before the latest inbound 24h window expires.
const FOLLOWUP_DUE_SQL=`(CASE WHEN rule.slot_hours=20
   THEN inbound.created_at
   WHEN rule.slot_hours=2 AND first_reply.staff_question
     THEN first_reply.at+INTERVAL '4 hours'
   ELSE first_reply.at END)
   + rule.slot_hours * INTERVAL '1 hour'`;
// Resolve only the last enabled earlier slot. A later reminder must not jump
// ahead of an unsent, failed or ambiguous previous reminder.
// A fresh customer reply makes a new 24h service-window anchor. If the
// previous 2h/6h step was accepted shortly before that reply, reuse that
// verified delivery ONLY as a prerequisite for the next step. The cooldown
// still prevents resending the same 2h/6h video. Do not bridge staff
// intervention, unconfirmed sends, imported history, or a new treatment
// choice/withdrawal. All sends remain bound to the new inbound and AI reply.
const PREVIOUS_STEP_SQL=`
 LEFT JOIN LATERAL (
   SELECT preceding.slot_hours,
     COALESCE(
       (SELECT preceding_sent.completed_at
        FROM whatsapp_sender_followup_attempts preceding_sent
        WHERE preceding_sent.sender_id=sa.id
          AND preceding_sent.contact_id=c.id
          AND preceding_sent.anchor_message_id=inbound.id
          AND preceding_sent.slot_hours=preceding.slot_hours
          AND preceding_sent.status='accepted'
        ORDER BY preceding_sent.completed_at DESC LIMIT 1),
       (SELECT earlier.completed_at
        FROM whatsapp_sender_followup_attempts earlier
        JOIN messages previous_inbound
          ON previous_inbound.id=earlier.anchor_message_id
         AND previous_inbound.contact_id=c.id
         AND previous_inbound.role='user'
         AND previous_inbound.whatsapp_message_id IS NOT NULL
        LEFT JOIN messages previous_outbound
          ON previous_outbound.id=earlier.message_id
         AND previous_outbound.contact_id=c.id
         AND previous_outbound.role='assistant'
        JOIN whatsapp_sender_message_context previous_context
          ON previous_context.message_id=previous_inbound.id
         AND previous_context.conversation_id=sc.id
        WHERE earlier.sender_id=sa.id AND earlier.contact_id=c.id
          AND earlier.slot_hours=preceding.slot_hours
          AND earlier.status='accepted'
          AND earlier.completed_at IS NOT NULL
          AND earlier.completed_at<inbound.created_at
          AND earlier.completed_at>=inbound.created_at-INTERVAL '24 hours'
          AND (previous_inbound.created_at,previous_inbound.id)
              <(inbound.created_at,inbound.id)
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_sender_coexistence_history_messages imported
            WHERE imported.sender_id=sa.id
              AND imported.message_id=previous_inbound.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM messages human_between
            WHERE human_between.contact_id=c.id
              AND human_between.role='assistant'
              AND human_between.sent_by_username IS NOT NULL
              AND human_between.is_automated_follow_up IS DISTINCT FROM TRUE
              AND human_between.created_at>=earlier.completed_at
              AND human_between.created_at<=inbound.created_at
          )
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_sender_followup_attempts uncertain_between
            WHERE uncertain_between.sender_id=sa.id
              AND uncertain_between.contact_id=c.id
              AND uncertain_between.status IN('unknown','blocked')
              AND uncertain_between.claimed_at>=earlier.completed_at
              AND uncertain_between.claimed_at<=inbound.created_at
          )
          -- A new treatment selection must not inherit media for another
          -- service. A newly repeated SAME treatment may continue only
          -- when the accepted old outbound stored an exact service snapshot.
          -- Legacy attempts without snapshots remain blocked on a new choice.
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_sender_followup_treatment_state changed
            WHERE changed.sender_id=sa.id AND changed.contact_id=c.id
              AND changed.source_message_id>earlier.anchor_message_id
              AND changed.source_message_id<=inbound.id
              AND (changed.status IS DISTINCT FROM 'selected'
                OR NULLIF(BTRIM(previous_outbound.whatsapp_template->>'treatmentInterest'),'') IS NULL
                OR LOWER(BTRIM(changed.treatment_name))
                   IS DISTINCT FROM LOWER(BTRIM(previous_outbound.whatsapp_template->>'treatmentInterest')))
          )
        ORDER BY earlier.completed_at DESC LIMIT 1)
     ) AS completed_at
   FROM whatsapp_sender_followup_rules preceding
   WHERE preceding.sender_id=rule.sender_id AND preceding.enabled=TRUE
     AND preceding.slot_hours IN(2,6,20)
     AND preceding.slot_hours<rule.slot_hours
   ORDER BY preceding.slot_hours DESC LIMIT 1
 ) previous_step ON TRUE
`;// The 20h check-in must stay inside the customer's original 24h reply
// window. Quiet hours may delay the 6h video until 07:00 MYT; adding
// (20-6)=14 hours after its actual delivery can make 20h impossible.
// Preserve accepted-step ordering, but require only a short spacing buffer
// after a delayed video. Do not let downtime generate backdated messages.
const SEQUENCE_DUE_SQL=`(CASE WHEN rule.slot_hours=20
 THEN GREATEST(
   ${FOLLOWUP_DUE_SQL},
   COALESCE(previous_step.completed_at + INTERVAL '15 minutes',
     ${FOLLOWUP_DUE_SQL}),
   CASE WHEN first_reply.staff_reply THEN first_reply.at+INTERVAL '2 hours'
     ELSE ${FOLLOWUP_DUE_SQL} END
 )
 ELSE GREATEST(
   ${FOLLOWUP_DUE_SQL},
   COALESCE(previous_step.completed_at +
     (rule.slot_hours - previous_step.slot_hours) * INTERVAL '1 hour',
     ${FOLLOWUP_DUE_SQL})
 )
 END)`;

// A new inbound restarts a sequence, but does not mean the customer wants
// another sales reminder after saying goodbye, asking only about a distant
// branch, or pitching a business partnership. Apply the same fail-closed SQL
// at discovery and immediately before dispatch.

// The fixed Meta 131060 recovery greeting may be followed up without a
// customer treatment selection. It must be provider-accepted, tied to the
// original sender-bound unavailable message and never treated as a treatment
// enquiry, ad click, marketing opt-in or permission to send media/templates.
const RECOVERY_NO_SELECTION_SQL=String.raw`(
  inbound.content LIKE '📎 [% sent a WhatsApp message that could not be displayed]'
  AND EXISTS (
    SELECT 1 FROM messages verified_recovery
    JOIN whatsapp_sender_message_context verified_recovery_context
      ON verified_recovery_context.message_id=verified_recovery.id
      AND verified_recovery_context.conversation_id=sc.id
    JOIN outbound_message_evidence recovery_evidence
      ON recovery_evidence.message_id=verified_recovery.id
      AND recovery_evidence.contact_id=c.id
      AND recovery_evidence.channel='whatsapp'
      AND recovery_evidence.origin='system_fallback'
      AND recovery_evidence.accepted=TRUE
      AND recovery_evidence.provider_message_id=verified_recovery.whatsapp_message_id
    WHERE verified_recovery.contact_id=c.id
      AND verified_recovery.role='assistant'
      AND verified_recovery.whatsapp_message_id IS NOT NULL
      AND verified_recovery.created_at>=inbound.created_at
      AND verified_recovery.created_at<inbound.created_at+INTERVAL '24 hours'
      AND (verified_recovery.created_at,verified_recovery.id)<=(first_reply.at,first_reply.id)
      AND verified_recovery.content LIKE 'Hi～欢迎来到 Neutro Sense 😊%'
      AND verified_recovery.content LIKE '%可以点下面的选项%'
      -- Meta's initial WAMID acceptance is not final delivery evidence.
      -- Hold a reminder unless the provider has subsequently confirmed a
      -- sent/delivered/read state, and never follow up a failed menu.
      AND verified_recovery.delivery_status IN ('sent','delivered','read')
      AND NOT EXISTS (
        SELECT 1 FROM whatsapp_sender_coexistence_history_messages old_menu
        WHERE old_menu.sender_id=sa.id AND old_menu.message_id=verified_recovery.id
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM messages newer_customer
    WHERE newer_customer.contact_id=c.id AND newer_customer.role='user'
      AND (newer_customer.created_at,newer_customer.id)
          >(inbound.created_at,inbound.id)
      -- Another unreadable event is not a treatment selection. It does not
      -- restart the seven-day recovery menu or suppress a verified reminder.
      AND newer_customer.content NOT LIKE
          '📎 [% sent a WhatsApp message that could not be displayed]'
  )
)`;
const RECOVERY_REMINDER_TEXT=Object.freeze({
  zh:Object.freeze({
    2:"Hi dear 😊 想跟进一下，您想了解哪方面的护理呢？可以点上面的选项，或直接告诉我们想改善的情况哦。",
    6:"您好 😊 如果还不确定适合什么护理，也可以简单说说您的需求，我们会先了解情况，再安排适合的评估哦。",
    20:"Hi dear 😊 再轻轻跟进一下～如果想了解护理或预约中医师评估，随时回复我们就好 ❤️",
  }),
  en:Object.freeze({
    2:"Hi 😊 Just following up. What would you like to know about our treatments? You can choose an option above or tell us what concerns you.",
    6:"Hello 😊 If you are unsure which treatment is suitable, feel free to share your concerns. We can understand your needs before arranging an assessment.",
    20:"Hi 😊 A gentle final follow-up. If you have questions or would like to arrange an assessment, you are welcome to reply anytime.",
  }),
  ms:Object.freeze({
    2:"Hai 😊 Kami nak susuli pertanyaan anda. Boleh pilih pilihan di atas atau beritahu apa yang anda ingin tahu tentang rawatan kami.",
    6:"Hai 😊 Jika belum pasti rawatan yang sesuai, boleh ceritakan keperluan anda. Kami boleh fahamkan keadaan dahulu sebelum cadangkan penilaian.",
    20:"Hai 😊 Sekadar susulan terakhir. Jika ada soalan atau ingin aturkan penilaian, boleh balas mesej ini bila-bila masa.",
  }),
});
function recoveryNoSelectionReminderText(slot,language){
  return (RECOVERY_REMINDER_TEXT[["zh","en","ms"].includes(language)?language:"zh"]||{})[slot]||null;
}

const CUSTOMER_FOLLOWUP_GUARD_SQL=String.raw`
 -- An unreadable Meta 131060 first message is not a genuine service enquiry.
 -- An automatic request to resend must never start the 2h/6h/20h sequence.
 AND (COALESCE(inbound.content,'') NOT LIKE '📎 [%sent a WhatsApp message that could not be displayed]'
      OR ${RECOVERY_NO_SELECTION_SQL})
 AND COALESCE(inbound.content,'') !~* '^(谢谢|謝謝|多谢|多謝|thanks|thank you|thank u|tq|terima kasih)[[:space:].!！。🙏😊]*$'
 AND COALESCE(inbound.content,'') !~* '${DISTANCE_OBJECTION_SQL}'
 AND COALESCE(inbound.content,'') !~* '(health[[:space:]]+professional[[:space:]]+program|business[[:space:]]+(collaboration|partnership)|医疗专业人员|醫療專業人員|商务合作|商業合作|邀请.{0,50}zoom|邀請.{0,50}zoom)'
 -- If the same authenticated inbound explicitly replaces an old treatment,
 -- its recorded new selection clears a lexical "not interested in 3D" match.
 -- A failed/missing state write does NOT bypass the withdrawal guard.
 AND (
   (COALESCE(inbound.content,'') !~* '(算了.{0,20}(不要|不用)|((暂时|暫時)?(不要了|不用了|不需要了|不做了|不考虑了|不考慮了))|没兴趣|沒興趣|不感兴趣|不感興趣|not interested|no longer interested|tak berminat|tidak berminat)'
    AND COALESCE(inbound.content,'') !~* '(我再(联系|聯繫|通知|回复|回覆)你|我(再)?(考虑|考慮)一下|let me (think|consider)|i will (let you know|get back)|saya akan hubungi nanti)')
   OR EXISTS (
     SELECT 1 FROM whatsapp_sender_followup_treatment_state explicit_switch
     WHERE explicit_switch.sender_id=sa.id AND explicit_switch.contact_id=c.id
       AND explicit_switch.source_message_id=inbound.id
       AND explicit_switch.status='selected'
   )
 )
 AND NOT (
   COALESCE(inbound.content,'') ~* '(penang|槟城|檳城|johor|jb).{0,35}(branch|分行|分店)'
   AND COALESCE(inbound.content,'') !~* '(petaling jaya|[[:<:]]pj[[:>:]]|kuala lumpur|[[:<:]]kl[[:>:]])'
 )
`;
// An explicit, sender-verified withdrawal or deferral blocks every reminder.
const SECONDARY_DECISION_HOLD_SQL=`
 AND NOT EXISTS(
   SELECT 1 FROM whatsapp_sender_followup_treatment_state declined_state
   WHERE declined_state.sender_id=sa.id AND declined_state.contact_id=c.id
     AND declined_state.source_message_id<=inbound.id
     AND declined_state.status IN('declined','deferred')
 )
`;
// A customer replying again must not cause the identical 2h or 6h video to
// be sent twice in a few hours. Other slots remain independent.
function repeatSlotCooldownSql(atSql){
 return `AND NOT EXISTS (
   SELECT 1 FROM whatsapp_sender_followup_attempts same_slot
   WHERE same_slot.sender_id=sa.id AND same_slot.contact_id=c.id
     AND same_slot.slot_hours=rule.slot_hours
     AND same_slot.status='accepted'
     AND same_slot.completed_at > ${atSql} -
       (CASE WHEN rule.slot_hours IN (2,6)
        THEN INTERVAL '7 days' ELSE INTERVAL '12 hours' END)
 )`;
}

const CANDIDATES_SQL=`
 SELECT c.id AS contact_id,c.channel,c.whatsapp_number,c.whatsapp_sender_id,
   sa.sender_key AS whatsapp_sender_key,
   sa.meta_phone_number_id AS whatsapp_sender_phone_number_id,
   sa.meta_account_id AS whatsapp_sender_account_id,
   sc.id AS conversation_id,
   inbound.id AS inbound_id,inbound.created_at AS inbound_at,
   rule.sender_id,rule.slot_hours,rule.message_text,rule.media_key,
   rule.media_type,rule.media_mime_type,rule.media_filename,
   first_reply.text AS first_reply_text,
   first_reply.staff_reply,first_reply.staff_question,
   ${RECOVERY_NO_SELECTION_SQL} AS recovery_no_selection,
   rule.updated_at AS rule_updated_at,
   EXTRACT(EPOCH FROM rule.updated_at)::text AS rule_version,
   lead.treatment_interest,
   lead.marketing_consent AS lead_marketing_consent,
   EXISTS (
     SELECT 1 FROM whatsapp_free_entry_referrals r
     JOIN messages ad ON ad.id=r.origin_message_id
       AND ad.contact_id=c.id AND ad.role='user'
     JOIN whatsapp_sender_message_context ad_ctx
       ON ad_ctx.message_id=ad.id AND ad_ctx.conversation_id=sc.id
     WHERE r.contact_id=c.id AND r.source_type='ad'
       AND (NULLIF(BTRIM(r.ctwa_clid),'') IS NOT NULL
        OR NULLIF(BTRIM(r.meta_ad_id),'') IS NOT NULL)
       AND ad.whatsapp_message_id IS NOT NULL
       AND ad.created_at>=inbound.created_at-INTERVAL '7 days'
       AND ad.created_at<=inbound.created_at
       AND NOT EXISTS(
         SELECT 1 FROM whatsapp_sender_coexistence_history_messages imported
         WHERE imported.sender_id=sa.id AND imported.message_id=ad.id
       )
   ) AS verified_meta_ad,
   treatment_state.status AS verified_treatment_status,
   treatment_state.treatment_name AS verified_treatment_name,
   ad_followup.source AS ad_followup_source,
   ad_followup.headline AS ad_followup_headline,
   ad_followup.body AS ad_followup_body,
   -- Carry forward a verified customer treatment choice after later price,
   -- package or branch questions. Five turns excluded #8943's pelvic request.
   -- Keep the sample recent, bounded and tied to THIS sender's conversation;
   -- never use imported Business App history as treatment evidence.
   ARRAY(SELECT LEFT(language_turn.content,500) FROM messages language_turn
     JOIN whatsapp_sender_message_context language_context
       ON language_context.message_id=language_turn.id
       AND language_context.conversation_id=sc.id
     WHERE language_turn.contact_id=c.id AND language_turn.role='user'
       AND language_turn.whatsapp_message_id IS NOT NULL
       AND language_turn.created_at >= inbound.created_at - INTERVAL '24 hours'
       AND NOT EXISTS (
         SELECT 1 FROM whatsapp_sender_coexistence_history_messages historical
         WHERE historical.sender_id=sa.id AND historical.message_id=language_turn.id
       )
       AND (language_turn.created_at,language_turn.id)
           <= (inbound.created_at,inbound.id)
     ORDER BY language_turn.created_at DESC,language_turn.id DESC LIMIT 20
   ) AS customer_texts
 FROM whatsapp_sender_followup_rules rule
 JOIN whatsapp_sender_accounts sa ON sa.id=rule.sender_id
   AND sa.state='active' AND sa.sender_key=$1
   AND sa.meta_phone_number_id=$2 AND sa.meta_account_id=$3
 -- The 24h service-window requirement below means every viable
 -- candidate must have a recent inbound. Materialize that inexpensive,
 -- indexed contact shortlist FIRST, instead of running many correlated
 -- history/consent checks for all of the sender's old conversations.
 -- This is a necessary-condition filter only: the original latest-inbound,
 -- sender, consent, booking and pre-send guards remain authoritative.
 JOIN (
   SELECT DISTINCT recent.contact_id
   FROM messages recent
   WHERE recent.created_at > $4::timestamptz - INTERVAL '24 hours'
     AND recent.role='user'
     AND recent.whatsapp_message_id IS NOT NULL
 ) recent_contact ON TRUE
 JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
   AND sc.state='bound' AND sc.contact_id=recent_contact.contact_id
 JOIN contacts c ON c.id=sc.contact_id AND c.whatsapp_sender_id=sa.id
   AND c.channel='whatsapp' AND c.whatsapp_number=sc.customer_wa_id
 JOIN LATERAL (
   SELECT m.id,m.created_at,m.source_created_at,m.whatsapp_message_id,m.role,m.content FROM messages m
   JOIN whatsapp_sender_message_context mc ON mc.message_id=m.id
     AND mc.conversation_id=sc.id
   WHERE m.contact_id=c.id AND m.role='user'
     AND m.whatsapp_message_id IS NOT NULL
     -- Every eligible free-form follow-up already requires a live 24h
     -- inbound window. Bound the recovery-priority check to that window
     -- instead of scanning a patient's entire historical timeline.
     AND m.created_at > $4::timestamptz - INTERVAL '24 hours'
     AND NOT EXISTS(
       SELECT 1 FROM whatsapp_sender_coexistence_history_messages h
       WHERE h.message_id=m.id AND h.sender_id=sa.id
     )
   -- A second unreadable Meta event has no readable customer intent. Keep
   -- the earlier accepted recovery session as the anchor rather than
   -- switching to a duplicate placeholder that cannot receive a new menu.
   ORDER BY CASE WHEN
     m.content LIKE '📎 [% sent a WhatsApp message that could not be displayed]'
     AND m.source_created_at IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM messages prior_recovery
       JOIN whatsapp_sender_message_context prior_context
         ON prior_context.message_id=prior_recovery.id
         AND prior_context.conversation_id=sc.id
       JOIN outbound_message_evidence prior_acceptance
         ON prior_acceptance.message_id=prior_recovery.id
         AND prior_acceptance.contact_id=c.id
         AND prior_acceptance.channel='whatsapp'
         AND prior_acceptance.origin='system_fallback'
         AND prior_acceptance.accepted=TRUE
         AND prior_acceptance.provider_message_id=prior_recovery.whatsapp_message_id
       WHERE prior_recovery.contact_id=c.id
         AND prior_recovery.created_at>=m.created_at
         AND prior_recovery.created_at<m.created_at+INTERVAL '24 hours'
         AND prior_recovery.content LIKE 'Hi～欢迎来到 Neutro Sense 😊%'
         AND prior_recovery.content LIKE '%可以点下面的选项%'
         AND prior_recovery.delivery_status IN ('sent','delivered','read')
     )
     AND NOT EXISTS (
       SELECT 1 FROM messages readable_later
       WHERE readable_later.contact_id=c.id AND readable_later.role='user'
         AND (readable_later.created_at,readable_later.id)>(m.created_at,m.id)
         AND readable_later.content NOT LIKE
           '📎 [% sent a WhatsApp message that could not be displayed]'
     )
   THEN 1 ELSE 0 END DESC,m.created_at DESC,m.id DESC LIMIT 1
 ) inbound ON true
 ${FIRST_REPLY_SQL}
 ${PREVIOUS_STEP_SQL}
 LEFT JOIN LATERAL (
   SELECT lead.id,lead.marketing_consent,lead.is_closed,lead.appointment_status,
     lead.treatment_interest,
     stage.system_key AS stage_key
   FROM leads lead LEFT JOIN pipeline_stages stage ON stage.id=lead.stage_id
   WHERE lead.contact_id=c.id ORDER BY lead.created_at DESC,lead.id DESC
   LIMIT 1
 ) lead ON true
 LEFT JOIN LATERAL (
   SELECT attribution.source,attribution.headline,attribution.body
   FROM lead_attributions attribution
   WHERE attribution.lead_id = lead.id
   ORDER BY attribution.attributed_at DESC,attribution.id DESC
   LIMIT 1
 ) ad_followup ON true
 LEFT JOIN whatsapp_sender_followup_treatment_state treatment_state
   ON treatment_state.sender_id=sa.id AND treatment_state.contact_id=c.id
   AND treatment_state.source_message_id<=inbound.id
 WHERE rule.enabled=TRUE
   AND rule.slot_hours IN(2,6,20)
   AND ${secondaryAutomationEligibleSql('c','$6','inbound','$7','$8')}
   AND ${reviewedContactFollowupGuardSql("c","inbound")}
   AND ${pendingAcceptedAppointmentAllowedSql("c")}
   ${CUSTOMER_FOLLOWUP_GUARD_SQL}
   ${SECONDARY_DECISION_HOLD_SQL}
   AND NOT ${temporaryStaffConversationSql('c','inbound')}
   AND ${pendingCancellationFollowupAllowedSql('c')}
   ${repeatSlotCooldownSql('$4::timestamptz')}
   AND c.mode='ai' AND c.takeover_by IS NULL
   AND NOT first_reply.staff_pending_action
   AND (NOT first_reply.staff_question OR rule.slot_hours=2
      OR ${RECOVERY_NO_SELECTION_SQL})
   AND ${secondaryAutomationAttentionAllowedSql("c")}
   AND c.whatsapp_opt_out_at IS NULL
   AND c.whatsapp_marketing_opt_out_at IS NULL
   AND (
     (c.whatsapp_opt_in_at IS NOT NULL
       AND NULLIF(BTRIM(c.whatsapp_opt_in_source),'') IS NOT NULL
       AND lead.marketing_consent='opted_in')
     OR
     ($9::timestamptz IS NOT NULL
       AND inbound.created_at >= $9::timestamptz
       AND inbound.source_created_at >= $9::timestamptz
       AND COALESCE(lead.marketing_consent,'unknown')<>'opted_out')
   )
   AND COALESCE(lead.is_closed,FALSE)=FALSE
   AND COALESCE(lead.appointment_status,'none')
     NOT IN('set','visited','confirmed','booked','completed')
   AND COALESCE(lead.stage_key,'')
     NOT IN('appointment_set','visited','confirmed','booked','completed')
   AND EXTRACT(HOUR FROM ($4::timestamptz AT TIME ZONE 'Asia/Kuala_Lumpur'))
       BETWEEN 7 AND 23
   AND (rule.slot_hours<>20 OR
       ${SEQUENCE_DUE_SQL} < inbound.created_at + INTERVAL '24 hours')
   AND ${SEQUENCE_DUE_SQL} <= $4::timestamptz
   -- Catch up after quiet hours or a worker interruption, but never send
   -- a stale follow-up more than eight hours after its original due time.
   AND ${SEQUENCE_DUE_SQL}
       > $4::timestamptz - INTERVAL '8 hours'
   -- Follow-ups run in order. A later step needs its preceding enabled
   -- sender-specific step to have been accepted, not merely scheduled.
   AND (previous_step.slot_hours IS NULL OR previous_step.completed_at IS NOT NULL)
   AND inbound.created_at > $4::timestamptz - INTERVAL '24 hours'
   AND NOT EXISTS (
     SELECT 1 FROM messages human
     WHERE human.contact_id=c.id AND human.role='assistant'
       AND human.sent_by_username IS NOT NULL
       AND (human.created_at,human.id)>(first_reply.at,first_reply.id)
       AND COALESCE(human.whatsapp_customer_mutation,'')=''
       AND human.content NOT LIKE '🗑️ %'
   )
   AND NOT EXISTS (
     SELECT 1 FROM whatsapp_sender_followup_attempts previous
     WHERE previous.sender_id=sa.id AND previous.contact_id=c.id
       AND previous.anchor_message_id=inbound.id
       AND previous.status IN('unknown','blocked')
   )
   AND NOT EXISTS (
     SELECT 1 FROM whatsapp_sender_followup_attempts attempted
     WHERE attempted.sender_id=sa.id AND attempted.contact_id=c.id
       AND attempted.anchor_message_id=inbound.id
       AND attempted.slot_hours=rule.slot_hours
   )
 ORDER BY inbound.created_at,c.id,rule.slot_hours
 LIMIT $5
`;

const POTENTIAL_DUE_SQL=deriveSecondaryPotentialDueSql(CANDIDATES_SQL,{
  fromTable:"whatsapp_sender_followup_rules",
  dueExpression:SEQUENCE_DUE_SQL,
  quietWindowEndMarker:"   -- Follow-ups run in order.",
});

function enabled(env) {
 return Boolean(secondaryAutomationActivation(env)) &&
   env.WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_AI_SEND_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED==="true";
}

const RECHECK_SQL=`
 SELECT EXISTS (
 SELECT 1 FROM whatsapp_sender_followup_rules rule
 JOIN whatsapp_sender_accounts sa ON sa.id=rule.sender_id
   AND sa.sender_key=$4 AND sa.meta_phone_number_id=$5
   AND sa.meta_account_id=$6 AND sa.state='active'
 JOIN contacts c ON c.id=$1 AND c.whatsapp_sender_id=sa.id
 JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
   AND sc.contact_id=c.id AND sc.state='bound'
   AND sc.customer_wa_id=c.whatsapp_number
 JOIN messages inbound ON inbound.id=$2 AND inbound.contact_id=c.id
   AND inbound.role='user' AND inbound.whatsapp_message_id IS NOT NULL
   AND NOT EXISTS(
     SELECT 1 FROM whatsapp_sender_coexistence_history_messages h
     WHERE h.message_id=inbound.id AND h.sender_id=sa.id
   )
 JOIN whatsapp_sender_message_context mc ON mc.message_id=inbound.id
   AND mc.conversation_id=sc.id
 ${FIRST_REPLY_SQL}
 ${PREVIOUS_STEP_SQL}
 LEFT JOIN LATERAL (
   SELECT l.marketing_consent,l.is_closed,l.appointment_status,
     stage.system_key AS stage_key
   FROM leads l LEFT JOIN pipeline_stages stage ON stage.id=l.stage_id
   WHERE l.contact_id=c.id ORDER BY l.created_at DESC,l.id DESC LIMIT 1
 ) latest_lead ON TRUE
 JOIN whatsapp_sender_followup_attempts attempt ON
   attempt.sender_id=sa.id AND attempt.contact_id=c.id
   AND attempt.anchor_message_id=inbound.id
   AND attempt.slot_hours=$3 AND attempt.status='claimed'
 WHERE rule.sender_id=sa.id AND rule.slot_hours=$3 AND rule.enabled
   AND EXTRACT(EPOCH FROM rule.updated_at)::text=$7::text
   AND ${secondaryAutomationEligibleSql('c','$8','inbound','$9','$10')}
   AND ${reviewedContactFollowupGuardSql("c","inbound")}
   AND ${pendingAcceptedAppointmentAllowedSql("c")}
   ${CUSTOMER_FOLLOWUP_GUARD_SQL}
   ${SECONDARY_DECISION_HOLD_SQL}
   AND NOT ${temporaryStaffConversationSql('c','inbound')}
   AND ${pendingCancellationFollowupAllowedSql('c')}
   ${repeatSlotCooldownSql('NOW()')}
   AND c.mode='ai' AND c.takeover_by IS NULL
   AND NOT first_reply.staff_pending_action
   AND (NOT first_reply.staff_question OR rule.slot_hours=2
      OR ${RECOVERY_NO_SELECTION_SQL})
   AND ${secondaryAutomationAttentionAllowedSql("c")}
   AND c.whatsapp_opt_out_at IS NULL
   AND c.whatsapp_marketing_opt_out_at IS NULL
   AND (
     (c.whatsapp_opt_in_at IS NOT NULL
       AND NULLIF(BTRIM(c.whatsapp_opt_in_source),'') IS NOT NULL
       AND latest_lead.marketing_consent='opted_in')
     OR
     ($11::timestamptz IS NOT NULL
       AND inbound.created_at >= $11::timestamptz
       AND inbound.source_created_at >= $11::timestamptz
       AND COALESCE(latest_lead.marketing_consent,'unknown')<>'opted_out')
   )
   AND COALESCE(latest_lead.is_closed,FALSE)=FALSE
   AND COALESCE(latest_lead.appointment_status,'none')
     NOT IN('set','visited','confirmed','booked','completed')
   AND COALESCE(latest_lead.stage_key,'')
     NOT IN('appointment_set','visited','confirmed','booked','completed')
   AND NOT EXISTS(
     SELECT 1 FROM messages newer
     WHERE newer.contact_id=c.id AND newer.role='user'
       AND (newer.created_at,newer.id)>(inbound.created_at,inbound.id)
       AND (NOT ${RECOVERY_NO_SELECTION_SQL}
         OR newer.content NOT LIKE
            '📎 [% sent a WhatsApp message that could not be displayed]')
   )
   AND NOT EXISTS(
     SELECT 1 FROM messages human
     WHERE human.contact_id=c.id AND human.role='assistant'
       AND human.sent_by_username IS NOT NULL
       AND (human.created_at,human.id)>(first_reply.at,first_reply.id)
       AND COALESCE(human.whatsapp_customer_mutation,'')=''
       AND human.content NOT LIKE '🗑️ %'
   )
   AND inbound.created_at + INTERVAL '24 hours' > NOW() + INTERVAL '2 minutes'
   AND (rule.slot_hours<>20 OR
       ${SEQUENCE_DUE_SQL} < inbound.created_at + INTERVAL '24 hours')
   AND ${SEQUENCE_DUE_SQL} <= NOW()
   AND ${SEQUENCE_DUE_SQL}
       > NOW() - INTERVAL '8 hours'
   AND (previous_step.slot_hours IS NULL OR previous_step.completed_at IS NOT NULL)
   AND NOT EXISTS (
     SELECT 1 FROM whatsapp_sender_followup_attempts prior_problem
     WHERE prior_problem.sender_id=sa.id AND prior_problem.contact_id=c.id
       AND prior_problem.anchor_message_id=inbound.id
       AND prior_problem.id<>attempt.id
       AND prior_problem.status IN('unknown','blocked')
   )
   AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')) BETWEEN 7 AND 23
 ) AS allowed`;

async function runOnce({
  database=pool,env=process.env,
  now=new Date(),limit=10,
  sendText=sendSecondaryStaffText,
  store=messagesRepo,storage=mediaStorage,contacts=contactsRepo,
 getConfig=()=>configRepo.getConfig(),
 videoApproved=isCurrentApprovedFollowUpVideo,
 videoSelection=selectApprovedTreatmentVideo,
 // Inject only the existing, scoped AI-copy helper for deterministic tests.
 personalize20h=createPersonalized20h,
 onUnexpectedFailure=()=>{},
}={}) {
  const cutoff=secondaryAutomationActivation(env);
  if (!enabled(env)||!cutoff)return{disabled:true,attempted:0,accepted:0};
  const allowedLimit=Math.max(1,Math.min(20,Number(limit)||10));
  const items=(await monitoredFollowUpRead(database,CANDIDATES_SQL,[
    env.WHATSAPP_SECONDARY_SENDER_KEY,
    env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
    env.WHATSAPP_SECONDARY_WABA_ID,now,allowedLimit,cutoff,
    env.WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE,
    originalAdsOnlyCutoff(env),
    serviceFollowupParityActivation(env),
  ],"candidate")).rows||[];
  let attempted=0,accepted=0;
  for(let candidate of items) {
    const slot=Number(candidate.slot_hours);
    if(!SLOTS.has(slot) || !Number.isSafeInteger(Number(candidate.contact_id)))continue;
    const clinicConfig=getConfig();
    const adFollowUpPolicy=resolveAdFollowUpTreatment({
      adSource:candidate.ad_followup_source,
      headline:candidate.ad_followup_headline,body:candidate.ad_followup_body,
      customerTexts:candidate.customer_texts,
      services:clinicConfig?.services,serviceAliases:clinicConfig?.serviceAliases,
    });
    const latestDecision=classifyVerifiedTreatmentTurn({
      text:candidate.customer_texts?.[0],clinicConfig,
    });
    // Reject the entire reminder after an explicit withdrawal or deferral.
    if(isStoppedDecision(latestDecision?.status) ||
       isStoppedDecision(candidate.verified_treatment_status))continue;
    const choice=chooseSecondaryFollowUpTreatment({
      candidate,clinicConfig,adFollowUpPolicy,latestDecision,
    });
    // Without readable patient intent, even an old CRM/ad treatment is
    // not evidence of what this 131060 customer wants.
    const generalOnly=candidate.recovery_no_selection?true:choice.generalOnly;
    const confirmedTreatment=candidate.recovery_no_selection?null:choice.treatment;
    // The 20h AI invitation must not reuse a stale CRM/ad treatment either.
    const effectivePolicy=confirmedTreatment
      ? {ambiguous:false,treatment:confirmedTreatment,source:"resolved_followup"}
      : adFollowUpPolicy;
    candidate={...candidate,adFollowUpPolicy:effectivePolicy};
    const customerLanguage=detectConversationLanguage(candidate.customer_texts||[],null);
    // A generic "PM" provides no language evidence; fall back to the already
    // delivered first reply, not the internal ad name or CRM treatment.
    const replyLanguage=customerLanguage ||
      detectConversationLanguage([candidate.first_reply_text].filter(Boolean),null);
    const localized=neutralMixedAdFollowUp({
      policy:generalOnly?adFollowUpPolicy:null,language:replyLanguage,slot,
    }) || localizedFollowUpText({
      slot,originalText:candidate.message_text,
      customerTexts:candidate.customer_texts,
      languageEvidenceTexts:[...candidate.customer_texts||[],candidate.first_reply_text],
      treatmentInterest:confirmedTreatment,
      selectedTreatment:confirmedTreatment,
      clinicConfig,
      forceGeneral:generalOnly,
    });
    // A question from staff gets one low-pressure nudge, not a treatment ad.
    const safeText=candidate.recovery_no_selection
      ? recoveryNoSelectionReminderText(slot,replyLanguage)
      : candidate.staff_reply && candidate.staff_question
        ? gentleStaffQuestionNudge(replyLanguage) : localized;
    // Do not burn a one-shot attempt for a language we cannot establish.
    if(!safeText)continue;
    // Do not consume a one-shot follow-up attempt or send media from a
    // configured 2h/6h rule until secondary media has independent approval.
    if(candidate.media_key && !generalOnly && !candidate.staff_reply &&
       !candidate.recovery_no_selection &&
       env.WHATSAPP_SECONDARY_AI_MEDIA_ENABLED!=="true")continue;
    // Atomic unique one-shot claim across Render worker instances.
    const claimed=await database.query(
      `INSERT INTO whatsapp_sender_followup_attempts
        (sender_id,contact_id,anchor_message_id,slot_hours)
       VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
      [candidate.sender_id,candidate.contact_id,candidate.inbound_id,slot]
    );
    const id=claimed.rows?.[0]?.id;
    if(!id)continue;
    attempted++;
    let messageId=null;
    let phase="initial_recheck";
    const fail=async(code)=>{
      // Before a message is saved, no provider send is attempted. Keep that
      // one-shot slot blocked without labelling it a possibly delivered
      // WhatsApp message. Once saved, provider acceptance may be ambiguous:
      // preserve 'unknown' and never retry automatically.
      const beforeSave=messageId===null;
      await database.query(
        beforeSave
          ? "UPDATE whatsapp_sender_followup_attempts SET status='blocked',error_code=$2,completed_at=NOW() WHERE id=$1 AND status='claimed'"
          : "UPDATE whatsapp_sender_followup_attempts SET status='unknown',error_code=$2,completed_at=NOW() WHERE id=$1 AND status='claimed'",
        [id,String(code||"unknown").slice(0,120)]
      );
    };
    const preSendCheck=async()=>{
      const result=await database.query(RECHECK_SQL,[
        candidate.contact_id,candidate.inbound_id,slot,
        env.WHATSAPP_SECONDARY_SENDER_KEY,
        env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
        env.WHATSAPP_SECONDARY_WABA_ID,
        candidate.rule_version,cutoff,
        env.WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE,
        originalAdsOnlyCutoff(env),
        serviceFollowupParityActivation(env),
      ]);
      return result.rows?.[0]?.allowed===true;
    };
    try {
      if(!await preSendCheck()){await fail("sender_followup_policy_changed");continue;}
      phase="media_selection";
      const selectedVideo=!candidate.recovery_no_selection &&
        !candidate.staff_reply && !generalOnly &&
        !candidate.media_key && slot!==20 &&
        env.WHATSAPP_SECONDARY_AI_MEDIA_ENABLED==="true" ? videoSelection({
          slot,treatmentInterest:confirmedTreatment,
          env,clinicConfig,storage:mediaStorage,
        }) : null;
      const key=(generalOnly || candidate.staff_reply ||
        candidate.recovery_no_selection) ? null
        : candidate.media_key || selectedVideo?.mediaKey || null;
      const mediaType=key ? (candidate.media_key?candidate.media_type:selectedVideo?.mediaType) : null;
      const mediaMime=key ? (candidate.media_key?candidate.media_mime_type:selectedVideo?.mediaMimeType) : null;
      const mediaFilename=key ? (candidate.media_key?candidate.media_filename:selectedVideo?.mediaFilename) : null;
      // Never inherit approval forever from the saved rule. The source
      // clinic may remove/replace a video after rule creation.
      const liveVideoApproval=()=>{
        try{return videoApproved({
          slot,mediaKey:key,env,clinicConfig:getConfig(),storage:mediaStorage,
        })===true;}catch{return false;}
      };
      if(key && (mediaType!=="video" || !liveVideoApproval())){
        await fail("sender_followup_video_approval_revoked");continue;
      }
      const useSharedVideoCache=Boolean(key && secondaryVideoCacheEligible({
        env,storage,mediaKey:key,
      }));
      let bytes=null;
      if(key){
        const mime=mediaMime;
        const kind=mediaType;
        const filename=mediaFilename;
        if(!ALLOWED_MIME[kind]?.has(mime) ||
          !/^[A-Za-z0-9._ -]{1,180}$/.test(String(filename||""))){
          await fail("sender_followup_media_invalid");continue;
        }
        // Preserve the existing pre-save media validation when cache is OFF.
        // With the cache ON, a HEAD validates the object before any reuse,
        // avoiding a full R2 download on each approved follow-up.
        if(!useSharedVideoCache){
          bytes=await storage.downloadMedia(key,{maxBytes:MAX_MEDIA});
          if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_MEDIA){
            await fail("sender_followup_media_unavailable");continue;
          }
        }
      }
      // This is the PRIMARY Neutro follow-up AI generator, using only
      // sender-bound SECONDARY customer history. Generate after the one-shot
      // claim, and never send a static substitute when AI mode is explicitly on.
      let outboundText=safeText;
      let aiMode=null;
      phase="ai_generation";
      if(slot===20 && !candidate.recovery_no_selection && !generalOnly &&
         env.WHATSAPP_SECONDARY_20H_AI_PERSONALIZATION_ENABLED==="true"){
        const personalized=await personalize20h({candidate,database,env});
        if(!personalized?.ok){
          await fail(personalized?.code||"secondary_20h_ai_unavailable");continue;
        }
        outboundText=personalized.message;
        aiMode=personalized.mode;
      }
      // Offer a genuine, optional way to request Day2-Day6 marketing
      // follow-ups while the customer-service window is still open. This is
      // ONLY an invitation: no CTA, ad click or 131060 error grants consent.
      // A customer's later full affirmative WhatsApp reply must be verified
      // against this actually delivered sender-owned invitation.
      if(slot===20 && generalSixDay.enabled(env) &&
         new Date(candidate.inbound_at).getTime()>=
           new Date(generalSixDay.activation(env)).getTime() &&
         candidate.lead_marketing_consent!=="opted_in" &&
         (candidate.recovery_no_selection===true ||
          candidate.verified_meta_ad===true)){
        outboundText+="\n\n"+generalSixDayInvitation(replyLanguage);
      }
      if(!await preSendCheck()){
        await fail("secondary_followup_policy_changed_after_ai");continue;
      }
      phase="contact_lookup";
      const contact=await contacts.getContactById(candidate.contact_id);
      if(contact?.whatsapp_sender_key!==env.WHATSAPP_SECONDARY_SENDER_KEY ||
         String(contact.whatsapp_sender_id)!==String(candidate.sender_id)){
        await fail("sender_followup_owner_changed");continue;
      }
      phase="message_save";
      const saved=await store.saveMessage(candidate.contact_id,
        "assistant",outboundText,null,null,null,null,
        key?mediaMime:null,{
          whatsappTemplate:{automatedSecondaryFollowup:true,
            senderKey:env.WHATSAPP_SECONDARY_SENDER_KEY,
            slotHours:slot,anchorMessageId:candidate.inbound_id,
            treatmentInterest:confirmedTreatment||null,
            recoveryNoSelection:candidate.recovery_no_selection===true},
          isAutomatedFollowUp:true,mediaKey:key||null,
          mediaFilename:key?mediaFilename:null,
          initialDeliveryStatus:"unknown",
          initialDeliveryError:"Sender-scoped follow-up attempted; provider delivery not confirmed.",
        });
      messageId=saved.id;
      await database.query(
        "UPDATE whatsapp_sender_followup_attempts SET message_id=$2 WHERE id=$1",
        [id,messageId]
      );
      phase="provider_dispatch";
      const result=await sendText({
        contact,messageId,text:outboundText,
        origin:"followup",preSendCheck,anchorMessageId:candidate.inbound_id,
        ...(key?{dispatchTransport:async transport=>dispatchSecondaryFollowUpVideo({
          transport,mediaKey:key,mimeType:mediaMime,filename:mediaFilename,
          caption:outboundText,env,storage,preSendCheck,liveVideoApproval,
          prefetchedBytes:bytes,
        })}:{}),
      },{env,database});
      phase="provider_result_persist";
      if(result?.success===true && /^wamid\./.test(String(result.wamid||""))) {
        await store.setWhatsappMessageId(messageId,result.wamid,{
          preserveVerifiedSecondaryReceipt:true,
        });
      }
      if(result?.success===true && result?.unknown!==true &&
         /^wamid\./.test(String(result.wamid||""))) {
        await database.query(
          "UPDATE whatsapp_sender_followup_attempts SET status='accepted',wamid=$2,completed_at=NOW() WHERE id=$1",
          [id,result.wamid]
        );
        accepted++;
      } else await fail(result?.code||"sender_followup_delivery_unconfirmed");
    }catch{
      // Never automatically replay this one-shot attempt. Report a fixed,
      // content-free processing phase, not error messages or customer data.
      const safePhases=new Set([
        "initial_recheck","media_selection","ai_generation","contact_lookup",
        "message_save","provider_dispatch","provider_result_persist",
      ]);
      const safePhase=safePhases.has(phase)?phase:"unknown";
      try{onUnexpectedFailure({phase:safePhase,slot});}catch{}
      const prefix=messageId?"sender_followup_after_save_":"sender_followup_before_save_";
      await fail(prefix+safePhase).catch(()=>{});
    }
  }
  return {disabled:false,attempted,accepted};
}

async function nextPotentialDueAt({database=pool,env=process.env,now=new Date()}={}){
 const cutoff=secondaryAutomationActivation(env);
 if(!enabled(env)||!cutoff)return null;
 const result=await monitoredFollowUpRead(database,POTENTIAL_DUE_SQL,[
   env.WHATSAPP_SECONDARY_SENDER_KEY,
   env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
   env.WHATSAPP_SECONDARY_WABA_ID,now,cutoff,
   env.WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE,
   originalAdsOnlyCutoff(env),
   serviceFollowupParityActivation(env),
 ],"due-time hint");
 return result.rows?.[0]||null;
}

let scheduler=null;
function start({env=process.env,run=runOnce,readNextDue=nextPotentialDueAt,
 database=pool,events=realtimeEvents,createTimer,now}={}){
 if(!enabled(env)||scheduler)return false;
 scheduler=createSecondaryDueScheduler({
   label:"Secondary WhatsApp service followup scheduler",
   run,readNextDue,database,env,events,createTimer,now,
 });
 return scheduler.start();
}
function stop(){scheduler?.stop();scheduler=null;}
module.exports={
 CANDIDATES_SQL,RECHECK_SQL,POTENTIAL_DUE_SQL,PREVIOUS_STEP_SQL,enabled,
 serviceFollowupParityActivation,runOnce,
 nextPotentialDueAt,start,stop,
};
