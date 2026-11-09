"use strict";

// Independent, opt-in-only sender follow-ups. These messages never enter
// Neutro's follow-up queue, template billing or retry worker.
// Its media upload cache may be reused only with the distinct secondary phone ID.
// A claimed slot is one-shot even after timeout, worker crash or uncertain
// provider acceptance. Nothing sends while either flag or rules are disabled.
const {pool}=require("../db/db");
const {temporaryStaffConversationSql}=require('../utils/temporaryStaffConversation');
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

 // Use the first verified AI reply to the latest customer message as the
 // anchor for FU1/FU2, just as the primary WhatsApp does. A later customer
 // message starts a new sequence; staff replies never authorize automation.
const FIRST_REPLY_SQL=`
 JOIN LATERAL (
   SELECT reply.created_at AS at, reply.content AS text FROM messages reply
   JOIN whatsapp_sender_message_context reply_context
     ON reply_context.message_id=reply.id
    AND reply_context.conversation_id=sc.id
   WHERE reply.contact_id=c.id AND reply.role='assistant'
     AND reply.whatsapp_message_id IS NOT NULL
     AND reply.sent_by_username IS NULL
     AND reply.is_automated_follow_up IS DISTINCT FROM TRUE
     AND reply.created_at>=inbound.created_at
     AND reply.created_at<inbound.created_at + INTERVAL '24 hours'
   ORDER BY reply.created_at ASC,reply.id ASC LIMIT 1
 ) first_reply ON TRUE
`;
// FU3 remains four hours before the latest inbound 24h window expires.
const FOLLOWUP_DUE_SQL=`(CASE WHEN rule.slot_hours=20
   THEN inbound.created_at ELSE first_reply.at END)
   + rule.slot_hours * INTERVAL '1 hour'`;
// Resolve only the last enabled earlier slot. A later reminder must not jump
// ahead of an unsent, failed or ambiguous previous reminder.
const PREVIOUS_STEP_SQL=`
 LEFT JOIN LATERAL (
   SELECT preceding.slot_hours, preceding_sent.completed_at
   FROM whatsapp_sender_followup_rules preceding
   LEFT JOIN whatsapp_sender_followup_attempts preceding_sent
     ON preceding_sent.sender_id=sa.id AND preceding_sent.contact_id=c.id
    AND preceding_sent.anchor_message_id=inbound.id
    AND preceding_sent.slot_hours=preceding.slot_hours
    AND preceding_sent.status='accepted'
   WHERE preceding.sender_id=rule.sender_id AND preceding.enabled=TRUE
     AND preceding.slot_hours IN(2,6,20)
     AND preceding.slot_hours<rule.slot_hours
   ORDER BY preceding.slot_hours DESC LIMIT 1
 ) previous_step ON TRUE
`;
const SEQUENCE_DUE_SQL=`GREATEST(
  ${FOLLOWUP_DUE_SQL},
  COALESCE(previous_step.completed_at +
    (rule.slot_hours - previous_step.slot_hours) * INTERVAL '1 hour',
    ${FOLLOWUP_DUE_SQL})
)`;

// A new inbound restarts a sequence, but does not mean the customer wants
// another sales reminder after saying goodbye, asking only about a distant
// branch, or pitching a business partnership. Apply the same fail-closed SQL
// at discovery and immediately before dispatch.
const CUSTOMER_FOLLOWUP_GUARD_SQL=String.raw`
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
   rule.updated_at AS rule_updated_at,
   EXTRACT(EPOCH FROM rule.updated_at)::text AS rule_version,
   lead.treatment_interest,
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
     AND NOT EXISTS(
       SELECT 1 FROM whatsapp_sender_coexistence_history_messages h
       WHERE h.message_id=m.id AND h.sender_id=sa.id
     )
   ORDER BY m.created_at DESC,m.id DESC LIMIT 1
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
   AND c.mode='ai' AND ${secondaryAutomationAttentionAllowedSql("c")}
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
   AND ${SEQUENCE_DUE_SQL} <= $4::timestamptz
   -- Catch up after quiet hours or a worker interruption, but never send
   -- a stale follow-up more than eight hours after its original due time.
   AND ${SEQUENCE_DUE_SQL}
       > $4::timestamptz - INTERVAL '8 hours'
   -- Follow-ups run in order. A later step needs its preceding enabled
   -- sender-specific step to have been accepted, not merely scheduled.
   AND (previous_step.slot_hours IS NULL OR previous_step.completed_at IS NOT NULL)
   AND inbound.created_at > $4::timestamptz - INTERVAL '24 hours'
   AND EXISTS (
     SELECT 1 FROM messages reply JOIN whatsapp_sender_message_context mc
       ON mc.message_id=reply.id AND mc.conversation_id=sc.id
     WHERE reply.contact_id=c.id AND reply.role='assistant'
       AND reply.whatsapp_message_id IS NOT NULL
       AND reply.sent_by_username IS NULL
       AND reply.is_automated_follow_up IS DISTINCT FROM TRUE
       AND reply.created_at>=inbound.created_at
   )
   AND NOT EXISTS (
     SELECT 1 FROM messages human
     WHERE human.contact_id=c.id AND human.role='assistant'
       AND human.sent_by_username IS NOT NULL
       AND human.created_at>=inbound.created_at
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
   AND c.mode='ai' AND ${secondaryAutomationAttentionAllowedSql("c")}
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
   )
   AND NOT EXISTS(
     SELECT 1 FROM messages human
     WHERE human.contact_id=c.id AND human.role='assistant'
       AND human.sent_by_username IS NOT NULL
       AND human.created_at>=inbound.created_at
   )
   AND inbound.created_at + INTERVAL '24 hours' > NOW() + INTERVAL '2 minutes'
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
    const {generalOnly}=choice;
    const confirmedTreatment=choice.treatment;
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
    // Do not burn a one-shot attempt for a language we cannot establish.
    if(!localized)continue;
    // Do not consume a one-shot follow-up attempt or send media from a
    // configured 2h/6h rule until secondary media has independent approval.
    if(candidate.media_key && !generalOnly &&
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
      await database.query(
        "UPDATE whatsapp_sender_followup_attempts SET status='unknown',error_code=$2,completed_at=NOW() WHERE id=$1 AND status='claimed'",
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
      const selectedVideo=!generalOnly &&
        !candidate.media_key && slot!==20 &&
        env.WHATSAPP_SECONDARY_AI_MEDIA_ENABLED==="true" ? videoSelection({
          slot,treatmentInterest:confirmedTreatment,
          env,clinicConfig,storage:mediaStorage,
        }) : null;
      const key=generalOnly ? null
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
      let outboundText=localized;
      let aiMode=null;
      phase="ai_generation";
      if(slot===20 && !generalOnly &&
         env.WHATSAPP_SECONDARY_20H_AI_PERSONALIZATION_ENABLED==="true"){
        const personalized=await personalize20h({candidate,database,env});
        if(!personalized?.ok){
          await fail(personalized?.code||"secondary_20h_ai_unavailable");continue;
        }
        outboundText=personalized.message;
        aiMode=personalized.mode;
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
            slotHours:slot,anchorMessageId:candidate.inbound_id},
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
 CANDIDATES_SQL,RECHECK_SQL,POTENTIAL_DUE_SQL,enabled,
 serviceFollowupParityActivation,runOnce,
 nextPotentialDueAt,start,stop,
};
