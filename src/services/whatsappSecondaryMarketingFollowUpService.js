"use strict";
// Never share primary Neutro marketing templates, opt-in or billing entries.
// Exact one-shot sender, contact, inbound and template authorization required.
const {pool}=require("../db/db");
const contactsRepo=require("../db/contactsRepo");
const messagesRepo=require("../db/messagesRepo");
const policy=require("./whatsappSecondaryPolicyService");
const tools=require("./whatsappTemplateService");
const {sendSecondaryStaffText}=require("./whatsappSecondaryStaffDispatch");
const {adsOnlyActivation,adsOnlyEligibleSql}=require("./whatsappSecondaryAdsOnlyEligibility");

const INTERVAL=5*60*1000;
const SLOTS=new Set([48,72]);
function enabled(env=process.env){
 return Boolean(adsOnlyActivation(env)) &&
   env.PR395_STAGING_MODE!=="true" &&
   env.WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED==="true" &&
   env.WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED==="true" &&
   env.WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED==="true" &&
   env.WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED!=="true" &&
   env.WHATSAPP_SECONDARY_STAFF_SEND_ENABLED==="true" &&
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
const CANDIDATES_SQL=`
 SELECT c.id AS contact_id,c.channel,c.whatsapp_number,c.whatsapp_sender_id,
   sa.sender_key AS whatsapp_sender_key,
   sa.meta_phone_number_id AS whatsapp_sender_phone_number_id,
   sa.meta_account_id AS whatsapp_sender_account_id,
   sc.id AS conversation_id,sa.id AS sender_id,
   inbound.id AS inbound_id,inbound.created_at AS inbound_at,
   rule.slot_hours,rule.template_name,rule.language_code,
   rule.template_signature,rule.updated_at AS rule_updated_at,
   lead.treatment_interest
 FROM whatsapp_sender_marketing_followup_rules rule
 JOIN whatsapp_sender_accounts sa ON sa.id=rule.sender_id
   AND sa.state='active' AND sa.sender_key=$1
   AND sa.meta_phone_number_id=$2 AND sa.meta_account_id=$3
 JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
   AND sc.state='bound'
 JOIN contacts c ON c.id=sc.contact_id AND c.whatsapp_sender_id=sa.id
   AND c.channel='whatsapp' AND c.whatsapp_number=sc.customer_wa_id
 JOIN LATERAL(
   SELECT m.id,m.created_at FROM messages m
   JOIN whatsapp_sender_message_context mc ON mc.message_id=m.id
     AND mc.conversation_id=sc.id
   WHERE m.contact_id=c.id AND m.role='user' AND m.whatsapp_message_id IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_coexistence_history_messages h
       WHERE h.sender_id=sa.id AND h.message_id=m.id)
   ORDER BY m.created_at DESC,m.id DESC LIMIT 1
 ) inbound ON TRUE
 JOIN LATERAL(
   SELECT l.marketing_consent,l.treatment_interest,l.is_closed,l.appointment_status,
     stage.system_key AS stage_key
   FROM leads l LEFT JOIN pipeline_stages stage ON stage.id=l.stage_id
   WHERE l.contact_id=c.id ORDER BY l.created_at DESC,l.id DESC LIMIT 1
 ) lead ON TRUE
 WHERE rule.enabled=TRUE AND rule.operator_billing_approved=TRUE
   AND rule.slot_hours IN(48,72)
   AND ${adsOnlyEligibleSql("c","$6")}
   AND c.mode='ai' AND c.needs_attention=FALSE
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
   AND inbound.created_at+rule.slot_hours*INTERVAL '1 hour'<=$4::timestamptz
   AND inbound.created_at+rule.slot_hours*INTERVAL '1 hour'
     >$4::timestamptz-INTERVAL '8 hours'
   AND inbound.created_at>$4::timestamptz-INTERVAL '7 days'
   AND NOT EXISTS (
     SELECT 1 FROM whatsapp_sender_marketing_followup_rules newer
     WHERE newer.sender_id=rule.sender_id AND newer.enabled=TRUE
       AND newer.slot_hours>rule.slot_hours
       AND inbound.created_at+newer.slot_hours*INTERVAL '1 hour'<=$4::timestamptz
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
 ORDER BY inbound.created_at,c.id,rule.slot_hours LIMIT $5
`;
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
 const cutoff=adsOnlyActivation(env);
 if(!enabled(env)||!cutoff)return{disabled:true,attempted:0,accepted:0};
 const params=[env.WHATSAPP_SECONDARY_SENDER_KEY,
   env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID,
   now,Math.max(1,Math.min(20,Number(limit)||10)),cutoff];
 const candidates=(await database.query(CANDIDATES_SQL,params)).rows||[];
 let attempted=0,accepted=0;
 for(const candidate of candidates){
  const slot=Number(candidate.slot_hours);
  if(!SLOTS.has(slot))continue;
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
   const result=await database.query(RECHECK_SQL,[
    params[0],params[1],params[2],new Date(),1000,cutoff]);
   return result.rows?.some(x=>
    Number(x.contact_id)===Number(candidate.contact_id) &&
    Number(x.inbound_id)===Number(candidate.inbound_id) &&
    Number(x.slot_hours)===slot &&
    String(x.rule_updated_at)===String(candidate.rule_updated_at) &&
    x.template_signature===candidate.template_signature)===true;
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
     origin:"marketing_followup",
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
let timer=null;
function start({env=process.env,setIntervalFn=setInterval,run=runOnce}={}){
 if(!enabled(env)||timer)return false;
 timer=setIntervalFn(()=>run({env}).catch(e=>
   console.error("[secondary WhatsApp marketing] Worker failed:",e?.message)),INTERVAL);
 timer?.unref?.();
 return true;
}
function stop(){if(timer){clearInterval(timer);timer=null;}}
module.exports={CANDIDATES_SQL,RECHECK_SQL,enabled,approvedStaticMarketingTemplate,runOnce,start,stop};
