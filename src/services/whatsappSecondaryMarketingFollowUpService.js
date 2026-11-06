"use strict";
// Never share primary Neutro marketing templates, opt-in or billing entries.
// Exact one-shot sender, contact, inbound and template authorization required.
const {pool}=require("../db/db");
const {temporaryStaffConversationSql}=require("../utils/temporaryStaffConversation");
const {pendingCancellationFollowupAllowedSql}=require("../utils/appointmentCancellationSafety");
const contactsRepo=require("../db/contactsRepo");
const messagesRepo=require("../db/messagesRepo");
const policy=require("./whatsappSecondaryPolicyService");
const tools=require("./whatsappTemplateService");
const {sendSecondaryStaffText}=require("./whatsappSecondaryStaffDispatch");
const {secondaryAutomationActivation,secondaryAutomationEligibleSql,adsOnlyEligibleSql,
  reviewedContactFollowupGuardSql,originalAdsOnlyCutoff,secondaryAutomationAttentionAllowedSql }=require("./whatsappSecondaryAdsOnlyEligibility");
const { pendingAcceptedAppointmentAllowedSql }=require("../utils/pendingAcceptedAppointmentFollowUp");
const {secondaryAdsOnlyFullAiMode}=require("./whatsappSenderActivationGate");
const {detectConversationLanguage}=require("../utils/chatLanguage");
const realtimeEvents=require("../utils/realtimeEvents");
const {deriveSecondaryPotentialDueSql,createSecondaryDueScheduler}=
 require("../utils/secondaryDueTimeScheduler");

// Select a locale only from actual sender-owned customer text. Do not infer
// Malay from Latin characters or silently send English to an unknown speaker.
function customerTemplateLocale(messages){
 const detected=detectConversationLanguage(Array.isArray(messages)?messages:[],null);
 return detected==="zh"?"zh_CN":detected==="en"?"en_US":detected==="ms"?"ms":null;
}

const SLOTS=new Set([48,66,96,144]);
const EXTENDED_SLOTS=new Set([96,144]);
function extendedEnabled(env=process.env){
 return enabled(env) && env.WHATSAPP_SECONDARY_EXTENDED_DAY4_DAY6_ENABLED==="true";
}
function enabled(env=process.env){
 return Boolean(secondaryAutomationActivation(env)) &&
   env.PR395_STAGING_MODE!=="true" &&
   env.WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED==="true" &&
   ((env.WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED==="true" &&
     env.WHATSAPP_SECONDARY_STAFF_SEND_ENABLED==="true") ||
     secondaryAdsOnlyFullAiMode(env)) &&
   env.WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED==="true" &&
   env.WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED!=="true" &&
   env.WHATSAPP_SECONDARY_AI_SEND_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED==="true" &&
   env.WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED==="true" &&
   env.WHATSAPP_COEXISTENCE_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE==="primary" &&
   env.WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED==="true" &&
   typeof env.WHATSAPP_SECONDARY_TOKEN==="string" &&
   env.WHATSAPP_SECONDARY_TOKEN.trim().length>0 &&
   env.WHATSAPP_SECONDARY_MARKETING_FOLLOWUPS_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_MARKETING_BILLING_APPROVED==="true" &&
   env.WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED==="true";
}

 // Anchor 48h/66h to the first verified sender-owned business reply,
 // matching the primary WhatsApp session, not a later customer message.
const FIRST_REPLY_SQL=`
 JOIN LATERAL (
   SELECT reply.created_at AS at FROM messages reply
   JOIN whatsapp_sender_message_context reply_context
     ON reply_context.message_id=reply.id
    AND reply_context.conversation_id=sc.id
   WHERE reply.contact_id=c.id AND reply.role='assistant'
     AND reply.whatsapp_message_id IS NOT NULL
     AND reply.sent_by_username IS NULL
     AND reply.is_automated_follow_up IS DISTINCT FROM TRUE
     AND reply.created_at>=CASE WHEN $7::text='all_contacts'
        AND NOT (${adsOnlyEligibleSql("c","$8")})
      THEN inbound.created_at ELSE c.created_at END
     AND reply.created_at<(CASE WHEN $7::text='all_contacts'
        AND NOT (${adsOnlyEligibleSql("c","$8")})
      THEN inbound.created_at ELSE c.created_at END)+INTERVAL '24 hours'
   ORDER BY reply.created_at,reply.id LIMIT 1
 ) first_reply ON TRUE
`;

// Guard current message intent at discovery AND at the last provider recheck.
// The same SQL is inherited by the separately disabled Day4/Day6 path.
const MARKETING_CUSTOMER_INTENT_SQL=String.raw`
 AND COALESCE(inbound.last_customer_text,'') !~* '^(谢谢|謝謝|多谢|多謝|thanks|thank you|thank u|tq|terima kasih)[[:space:].!！。🙏😊]*$'
 AND COALESCE(inbound.last_customer_text,'') !~* '(health[[:space:]]+professional[[:space:]]+program|business[[:space:]]+(collaboration|partnership)|医疗专业人员|醫療專業人員|商务合作|商業合作|邀请.{0,50}zoom|邀請.{0,50}zoom)'
 AND NOT (
  COALESCE(inbound.last_customer_text,'') ~* '(penang|槟城|檳城|johor|jb).{0,35}(branch|分行|分店)'
  AND COALESCE(inbound.last_customer_text,'') !~* '(petaling jaya|[[:<:]]pj[[:>:]]|kuala lumpur|[[:<:]]kl[[:>:]])'
 )
`;
const CANDIDATES_SQL=`
 SELECT c.id AS contact_id,c.channel,c.whatsapp_number,c.whatsapp_sender_id,
   sa.sender_key AS whatsapp_sender_key,
   sa.meta_phone_number_id AS whatsapp_sender_phone_number_id,
   sa.meta_account_id AS whatsapp_sender_account_id,
   sc.id AS conversation_id,sa.id AS sender_id,
   inbound.id AS inbound_id,inbound.created_at AS inbound_at,
   inbound.customer_messages,
   rule.slot_hours,rule.template_name,rule.language_code,
   rule.template_signature,rule.updated_at AS rule_updated_at,
   lead.treatment_interest
 FROM whatsapp_sender_marketing_followup_rules rule
 JOIN whatsapp_sender_accounts sa ON sa.id=rule.sender_id
   AND sa.state='active' AND sa.sender_key=$1
   AND sa.meta_phone_number_id=$2 AND sa.meta_account_id=$3
 -- Every sendable 48h/66h slot needs a customer inbound in the
 -- last seven days. The separate Day4/Day6 query can refer to a verified
 -- ad origin up to 24h before its first reply, so use NINE days as the
 -- necessary-only shortlist for BOTH paths. Keep the existing exact latest
 -- inbound and provider/consent/booking/billing checks unchanged.
 JOIN (
   SELECT DISTINCT recent.contact_id
   FROM messages recent
   WHERE recent.created_at > $4::timestamptz - INTERVAL '9 days'
     AND recent.role='user'
     AND recent.whatsapp_message_id IS NOT NULL
 ) recent_contact ON TRUE
 JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
   AND sc.state='bound' AND sc.contact_id=recent_contact.contact_id
 JOIN contacts c ON c.id=sc.contact_id AND c.whatsapp_sender_id=sa.id
   AND c.channel='whatsapp' AND c.whatsapp_number=sc.customer_wa_id
 JOIN LATERAL(
   SELECT m.id,m.created_at,m.source_created_at,m.whatsapp_message_id,m.role,
     m.content AS last_customer_text, ARRAY(
     SELECT LEFT(recent.content,500) FROM messages recent
     JOIN whatsapp_sender_message_context recent_ctx
       ON recent_ctx.message_id=recent.id AND recent_ctx.conversation_id=sc.id
     WHERE recent.contact_id=c.id AND recent.role='user'
       AND recent.whatsapp_message_id IS NOT NULL
       AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_coexistence_history_messages imported
         WHERE imported.sender_id=sa.id AND imported.message_id=recent.id)
     ORDER BY recent.created_at DESC,recent.id DESC LIMIT 8
   ) AS customer_messages FROM messages m
   JOIN whatsapp_sender_message_context mc ON mc.message_id=m.id
     AND mc.conversation_id=sc.id
   WHERE m.contact_id=c.id AND m.role='user' AND m.whatsapp_message_id IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_coexistence_history_messages h
       WHERE h.sender_id=sa.id AND h.message_id=m.id)
   ORDER BY m.created_at DESC,m.id DESC LIMIT 1
 ) inbound ON TRUE
 ${FIRST_REPLY_SQL}
 JOIN LATERAL(
   SELECT l.marketing_consent,l.treatment_interest,l.is_closed,l.appointment_status,
     stage.system_key AS stage_key
   FROM leads l LEFT JOIN pipeline_stages stage ON stage.id=l.stage_id
   WHERE l.contact_id=c.id ORDER BY l.created_at DESC,l.id DESC LIMIT 1
 ) lead ON TRUE
 WHERE rule.enabled=TRUE AND rule.operator_billing_approved=TRUE
   AND rule.slot_hours IN(48,66)
   AND ${secondaryAutomationEligibleSql("c","$6","inbound","$7","$8")}
   AND ${reviewedContactFollowupGuardSql("c","inbound")}
   AND ${pendingAcceptedAppointmentAllowedSql("c")}
   ${MARKETING_CUSTOMER_INTENT_SQL}
   AND NOT ${temporaryStaffConversationSql('c','inbound')}
   AND ${pendingCancellationFollowupAllowedSql('c')}
   AND c.mode='ai' AND ${secondaryAutomationAttentionAllowedSql("c")}
   AND c.whatsapp_opt_in_at IS NOT NULL
   AND NULLIF(BTRIM(c.whatsapp_opt_in_source),'') IS NOT NULL
   AND c.whatsapp_opt_out_at IS NULL AND c.whatsapp_marketing_opt_out_at IS NULL
   AND lead.marketing_consent='opted_in' AND lead.is_closed=FALSE
   AND NULLIF(BTRIM(lead.treatment_interest),'') IS NOT NULL
   AND COALESCE(lead.appointment_status,'none')
     NOT IN('set','visited','confirmed','booked','completed')
   AND COALESCE(lead.stage_key,'')
     NOT IN('appointment_set','visited','confirmed','booked','completed')
   -- Only explicit, message-linked marketing opt-in belonging to this
   -- sender conversation; imported history or CTWA prefill alone is NOT proof.
   AND EXISTS (
     SELECT 1 FROM whatsapp_marketing_consent_events consent
     JOIN messages cm ON cm.id=consent.message_id
       AND cm.contact_id=c.id AND cm.role='user'
       AND cm.whatsapp_message_id IS NOT NULL
     JOIN whatsapp_sender_message_context consent_ctx
       ON consent_ctx.message_id=cm.id AND consent_ctx.conversation_id=sc.id
     WHERE consent.contact_id=c.id AND consent.consent_category='MARKETING'
       AND consent.consent_scope='treatment_followups_and_related_offers'
       AND consent.consented_at>=c.whatsapp_opt_in_at
       AND LOWER(BTRIM(consent.consent_service))=LOWER(BTRIM(lead.treatment_interest))
       AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_coexistence_history_messages h
         WHERE h.sender_id=sa.id AND h.message_id=cm.id)
   )
   AND EXTRACT(HOUR FROM ($4::timestamptz AT TIME ZONE 'Asia/Kuala_Lumpur'))
     BETWEEN 7 AND 23
   AND first_reply.at+rule.slot_hours*INTERVAL '1 hour'<=$4::timestamptz
   AND first_reply.at+rule.slot_hours*INTERVAL '1 hour'
     >$4::timestamptz-INTERVAL '8 hours'
   AND inbound.created_at>$4::timestamptz-INTERVAL '7 days'
   AND inbound.created_at<=$4::timestamptz-INTERVAL '24 hours'
   AND NOT EXISTS (
     SELECT 1 FROM whatsapp_sender_marketing_followup_rules newer
     WHERE newer.sender_id=rule.sender_id AND newer.enabled=TRUE
       AND newer.language_code=rule.language_code
       AND newer.slot_hours>rule.slot_hours
       AND first_reply.at+newer.slot_hours*INTERVAL '1 hour'<=$4::timestamptz
   )
   AND NOT EXISTS (
     SELECT 1 FROM messages human WHERE human.contact_id=c.id
       AND human.role='assistant' AND human.sent_by_username IS NOT NULL
       AND human.created_at>=inbound.created_at
   )
   AND NOT EXISTS (
     SELECT 1 FROM whatsapp_sender_marketing_followup_attempts bad
     WHERE bad.sender_id=sa.id AND bad.contact_id=c.id
       AND bad.anchor_message_id=inbound.id
       AND bad.status IN('unknown','blocked')
   )
   AND NOT EXISTS (
     SELECT 1 FROM whatsapp_sender_marketing_followup_attempts attempted
     WHERE attempted.sender_id=sa.id AND attempted.contact_id=c.id
       AND attempted.anchor_message_id=inbound.id
       AND attempted.slot_hours=rule.slot_hours
   )
 ORDER BY inbound.created_at,c.id,rule.slot_hours,rule.language_code LIMIT $5
`;
// This read-only hint keeps every candidate consent, sender and billing rule
// while looking ahead to the next sendable slot. The actual candidate selector
// and pre-send policy recheck still exclusively authorize messages.
const POTENTIAL_DUE_SQL=deriveSecondaryPotentialDueSql(CANDIDATES_SQL,{
 fromTable:"whatsapp_sender_marketing_followup_rules",
 dueExpression:"first_reply.at+rule.slot_hours*INTERVAL '1 hour'",
 quietWindowEndMarker:"   AND inbound.created_at>$4::timestamptz-INTERVAL '7 days'",
});
// Day4/Day6 must be anchored to the first verified reply in the seven-day
// ad-originated free-entry session, never the latest customer inbound.
const EXTENDED_SESSION_SQL=`
 JOIN LATERAL(
  SELECT origin.id AS origin_id, reply.created_at AS first_reply_at
  FROM whatsapp_free_entry_referrals referral
  JOIN messages origin ON origin.id=referral.origin_message_id
    AND origin.contact_id=c.id AND origin.role='user'
    AND origin.whatsapp_message_id IS NOT NULL
  JOIN whatsapp_sender_message_context origin_context
    ON origin_context.message_id=origin.id AND origin_context.conversation_id=sc.id
  JOIN LATERAL(
    SELECT first.id,first.created_at,first.whatsapp_message_id
    FROM messages first
    JOIN whatsapp_sender_message_context reply_context
      ON reply_context.message_id=first.id AND reply_context.conversation_id=sc.id
    WHERE first.contact_id=c.id AND first.role='assistant'
      AND first.whatsapp_message_id IS NOT NULL
      AND first.created_at>=origin.created_at
      AND first.created_at<origin.created_at+INTERVAL '24 hours'
    ORDER BY first.created_at,first.id LIMIT 1
  ) reply ON TRUE
  JOIN whatsapp_sender_status_receipts receipt ON receipt.sender_id=sa.id
    AND receipt.wamid=reply.whatsapp_message_id
    AND receipt.matched=TRUE AND receipt.pricing_type='free_entry_point'
    AND receipt.pricing_billable=FALSE
    AND receipt.delivery_status IN('sent','delivered','read')
    AND receipt.meta_phone_number_id=sa.meta_phone_number_id
    AND receipt.meta_account_id=sa.meta_account_id
  WHERE referral.contact_id=c.id AND referral.source_type='ad'
    AND (NULLIF(BTRIM(referral.ctwa_clid),'') IS NOT NULL
      OR NULLIF(BTRIM(referral.meta_ad_id),'') IS NOT NULL)
    AND origin.created_at >= $6::timestamptz
    AND NOT EXISTS (SELECT 1 FROM whatsapp_sender_coexistence_history_messages imported
      WHERE imported.sender_id=sa.id AND imported.message_id=origin.id)
    AND $4::timestamptz>=reply.created_at
    AND $4::timestamptz<reply.created_at+INTERVAL '167 hours'
    AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_status_receipts conflict
      WHERE conflict.sender_id=sa.id AND conflict.wamid=reply.whatsapp_message_id
        AND (conflict.pricing_billable IS DISTINCT FROM FALSE
          OR conflict.pricing_type IS DISTINCT FROM 'free_entry_point'
          OR conflict.delivery_status='failed'))
  ORDER BY reply.created_at,origin.id LIMIT 1
 ) qualified_session ON TRUE
`;
const EXTENDED_CANDIDATES_SQL=CANDIDATES_SQL
 .replace("inbound.id AS inbound_id,inbound.created_at AS inbound_at,",
  "qualified_session.origin_id AS inbound_id,qualified_session.first_reply_at AS inbound_at,")
 .replace(") lead ON TRUE",") lead ON TRUE"+EXTENDED_SESSION_SQL)
 .replace("rule.slot_hours IN(48,66)","rule.slot_hours IN(96,144)")
 .replaceAll("first_reply.at","qualified_session.first_reply_at")
 .replace("inbound.created_at>$4::timestamptz-INTERVAL '7 days'",
  "qualified_session.first_reply_at>$4::timestamptz-INTERVAL '7 days'")
 .replace("bad.anchor_message_id=inbound.id","bad.anchor_message_id IS NOT NULL")
 .replace("attempted.anchor_message_id=inbound.id",
  "attempted.anchor_message_id=qualified_session.origin_id")
 .replace("ORDER BY inbound.created_at,c.id,rule.slot_hours,rule.language_code LIMIT $5",
  `AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_billing_alarms alarm WHERE alarm.sender_id=sa.id)
   AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_billing_gates gate
      WHERE gate.sender_id=sa.id AND gate.state<>'idle')
   AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_marketing_followup_attempts other
      WHERE other.sender_id=sa.id AND other.contact_id=c.id
        AND other.slot_hours=rule.slot_hours
        AND other.status IN('accepted','unknown','blocked'))
   AND (SELECT COUNT(*) FROM whatsapp_sender_marketing_followup_attempts sent
      WHERE sent.sender_id=sa.id AND sent.contact_id=c.id AND sent.status='accepted')<4
  ORDER BY qualified_session.first_reply_at,c.id,rule.slot_hours,rule.language_code LIMIT $5`);

// Recheck with the existing claim; sender, real inbound, consent and operator
// rule version must stay eligible. No second claim after Meta ambiguity.
const RECHECK_SQL=CANDIDATES_SQL.replace(
 `   AND NOT EXISTS (
     SELECT 1 FROM whatsapp_sender_marketing_followup_attempts attempted
     WHERE attempted.sender_id=sa.id AND attempted.contact_id=c.id
       AND attempted.anchor_message_id=inbound.id
       AND attempted.slot_hours=rule.slot_hours
   )`,
 `   AND EXISTS (
     SELECT 1 FROM whatsapp_sender_marketing_followup_attempts attempted
     WHERE attempted.sender_id=sa.id AND attempted.contact_id=c.id
       AND attempted.anchor_message_id=inbound.id
       AND attempted.slot_hours=rule.slot_hours AND attempted.status='claimed'
   )`
);
const EXTENDED_RECHECK_SQL=EXTENDED_CANDIDATES_SQL.replace(
 `   AND NOT EXISTS (
     SELECT 1 FROM whatsapp_sender_marketing_followup_attempts attempted
     WHERE attempted.sender_id=sa.id AND attempted.contact_id=c.id
       AND attempted.anchor_message_id=qualified_session.origin_id
       AND attempted.slot_hours=rule.slot_hours
   )`,
 `   AND EXISTS (
     SELECT 1 FROM whatsapp_sender_marketing_followup_attempts attempted
     WHERE attempted.sender_id=sa.id AND attempted.contact_id=c.id
       AND attempted.anchor_message_id=qualified_session.origin_id
       AND attempted.slot_hours=rule.slot_hours AND attempted.status='claimed'
   )`
);
function approvedStaticMarketingTemplate(definition,expectedSignature){
 const normalized=tools.normalizeTemplate(definition);
 return normalized.status==="APPROVED" && normalized.category==="MARKETING" &&
   normalized.sendable===true &&
   normalized.header?.format!=="IMAGE" &&
   normalized.header?.format!=="VIDEO" &&
   normalized.variableFields.length===0 &&
   normalized.buttons.length===0 &&
   Boolean(normalized.body?.text) &&
   tools.templateSignature(normalized)===expectedSignature
     ?normalized:null;
}
async function runOnce({
 env=process.env,database=pool,now=new Date(),limit=10,
 contacts=contactsRepo,store=messagesRepo,templatePolicy=policy,
 send=sendSecondaryStaffText,fetchImpl=global.fetch,
}={}){
 const cutoff=secondaryAutomationActivation(env);
 if(!enabled(env)||!cutoff)return{disabled:true,attempted:0,accepted:0};
 const maxAttempts=Math.max(1,Math.min(20,Number(limit)||10));
 // A customer can have several configured languages but is only eligible
 // for ONE. Allow up to three candidate rows per slot, not extra attempts.
 const params=[env.WHATSAPP_SECONDARY_SENDER_KEY,
   env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID,
   now,maxAttempts*3,cutoff,env.WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE,
   originalAdsOnlyCutoff(env)];
 const candidates=(await database.query(CANDIDATES_SQL,params)).rows||[];
 if(extendedEnabled(env)){
   const extra=(await database.query(EXTENDED_CANDIDATES_SQL,params)).rows||[];
   candidates.push(...extra);
 }
 let attempted=0,accepted=0;
 for(const candidate of candidates){
  if(attempted>=maxAttempts)break;
  const slot=Number(candidate.slot_hours);
  if(!SLOTS.has(slot) ||
     (EXTENDED_SLOTS.has(slot) && !extendedEnabled(env)) ||
     customerTemplateLocale(candidate.customer_messages)!==candidate.language_code)continue;
  const claimed=await database.query(
   `INSERT INTO whatsapp_sender_marketing_followup_attempts
     (sender_id,contact_id,anchor_message_id,slot_hours)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
   [candidate.sender_id,candidate.contact_id,candidate.inbound_id,slot]);
  const id=claimed.rows?.[0]?.id;
  if(!id)continue;
  attempted++;
  const fail=async code=>database.query(
   "UPDATE whatsapp_sender_marketing_followup_attempts SET status='unknown',error_code=$2,completed_at=NOW() WHERE id=$1 AND status='claimed'",
   [id,String(code||"unconfirmed").slice(0,120)]).catch(()=>{});
  const current=async()=>{
   if(EXTENDED_SLOTS.has(slot) && !extendedEnabled(env))return false;
   const result=await database.query(EXTENDED_SLOTS.has(slot)?
     EXTENDED_RECHECK_SQL:RECHECK_SQL,[
    params[0],params[1],params[2],new Date(),1000,cutoff,env.WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE,
      originalAdsOnlyCutoff(env)]);
   return result.rows?.some(x=>
    Number(x.contact_id)===Number(candidate.contact_id) &&
    Number(x.inbound_id)===Number(candidate.inbound_id) &&
    Number(x.slot_hours)===slot &&
    String(x.rule_updated_at)===String(candidate.rule_updated_at) &&
    x.template_signature===candidate.template_signature &&
    x.template_name===candidate.template_name &&
    x.language_code===candidate.language_code &&
    customerTemplateLocale(x.customer_messages)===candidate.language_code)===true;
  };
  try{
   if(!await current()){await fail("secondary_marketing_policy_changed");continue;}
   const contact=await contacts.getContactById(candidate.contact_id);
   if(contact?.whatsapp_sender_key!==env.WHATSAPP_SECONDARY_SENDER_KEY ||
      String(contact.whatsapp_sender_id)!==String(candidate.sender_id)){
    await fail("secondary_marketing_owner_changed");continue;
   }
   const validateTemplate=async()=>{
    const result=await templatePolicy.previewSecondaryTemplatePolicy(contact,{
     name:candidate.template_name,languageCode:candidate.language_code,
     treatmentInterest:candidate.treatment_interest,
     env,database,fetchImpl,now:new Date(),
    });
    if(result.policyAllowed!==true || result.template?.category!=="MARKETING")
      return null;
    return approvedStaticMarketingTemplate(
      result.template.definition,candidate.template_signature);
   };
   const template=await validateTemplate();
   if(!template){await fail("secondary_marketing_template_or_consent_unverified");continue;}
   if(!await current()){await fail("secondary_marketing_policy_revoked");continue;}
   const saved=await store.saveMessage(
    candidate.contact_id,"assistant",template.body.text,null,null,null,null,null,{
     whatsappTemplate:{
      automatedSecondaryMarketingFollowup:true,
      senderKey:env.WHATSAPP_SECONDARY_SENDER_KEY,slotHours:slot,
      anchorMessageId:candidate.inbound_id,
      templateSignature:candidate.template_signature,
      name:template.name,language:template.language,
     },
     isAutomatedFollowUp:true,initialDeliveryStatus:"unknown",
     initialDeliveryError:"Secondary marketing template attempted; provider delivery unconfirmed.",
    });
   await database.query(
    "UPDATE whatsapp_sender_marketing_followup_attempts SET message_id=$2 WHERE id=$1 AND status='claimed'",
    [id,saved.id]);
   const result=await send({
     contact,messageId:saved.id,text:"[approved-marketing-template]",
     origin:"marketing_followup",anchorMessageId:candidate.inbound_id,
     templateRequest:{
      name:template.name,languageCode:template.language,
      treatmentInterest:candidate.treatment_interest,
      expectedSignature:candidate.template_signature,
      billingConfirmed:true,automatedMarketingApproved:true,
     },
     preSendCheck:async()=>await current() && Boolean(await validateTemplate()),
     dispatchTransport:async transport=>{
      if(!await current() || !await validateTemplate())
       return{success:false,ambiguous:true,retryable:false};
      return transport.sendTemplatePayload(template.name,template.language,[]);
     },
   },{database,env,fetchImpl});
   if(result.success===true && /^wamid\./.test(String(result.wamid||"")) &&
      result.unknown!==true){
    await store.setWhatsappMessageId(saved.id,result.wamid,{
     preserveVerifiedSecondaryReceipt:true});
    await database.query(
     "UPDATE whatsapp_sender_marketing_followup_attempts SET status='accepted',wamid=$2,completed_at=NOW() WHERE id=$1 AND status='claimed'",
     [id,result.wamid]);
    accepted++;
   }else await fail(result?.code||"secondary_marketing_send_unconfirmed");
  }catch{await fail("secondary_marketing_unconfirmed");}
 }
 return{disabled:false,attempted,accepted};
}
async function nextPotentialDueAt({database=pool,env=process.env,now=new Date()}={}){
 const cutoff=secondaryAutomationActivation(env);
 if(!enabled(env)||!cutoff)return null;
 const result=await database.query(POTENTIAL_DUE_SQL,[
   env.WHATSAPP_SECONDARY_SENDER_KEY,
   env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
   env.WHATSAPP_SECONDARY_WABA_ID,now,cutoff,
   env.WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE,
   originalAdsOnlyCutoff(env),
 ]);
 return result.rows?.[0]||null;
}

let scheduler=null;
function start({env=process.env,run=runOnce,readNextDue=nextPotentialDueAt,
 database=pool,events=realtimeEvents,createTimer,now}={}){
 if(!enabled(env)||scheduler)return false;
 scheduler=createSecondaryDueScheduler({
   label:"Secondary WhatsApp marketing followup scheduler",
   run,readNextDue,database,env,events,createTimer,now,
 });
 return scheduler.start();
}
function stop(){scheduler?.stop();scheduler=null;}
module.exports={
 CANDIDATES_SQL,RECHECK_SQL,EXTENDED_CANDIDATES_SQL,EXTENDED_RECHECK_SQL,
 MARKETING_CUSTOMER_INTENT_SQL,
 POTENTIAL_DUE_SQL,enabled,extendedEnabled,customerTemplateLocale,
 approvedStaticMarketingTemplate,runOnce,nextPotentialDueAt,start,stop,
};
