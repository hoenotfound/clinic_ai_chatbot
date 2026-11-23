"use strict";
const {pool}=require("./db");
const {isExplicitRm68Interest}=require("../utils/neutroRm68InterestEvidence");
const CAMPAIGN="neutro_breast_rm68_2026";
const SERVICE="草药胸部疏通乳腺护理";
async function recordRm68CustomerInterest({contactId,messageId,text,clinicConfig,database=pool}={}){
 if(!Number.isSafeInteger(Number(contactId))||Number(contactId)<1||
    !Number.isSafeInteger(Number(messageId))||Number(messageId)<1||
    !/^neutro\s+sense\s+tcm(?:\s+centre)?$/iu.test(
      String(clinicConfig?.businessName||clinicConfig?.clinicName||"").trim())||
    !Array.isArray(clinicConfig?.services)||
    !clinicConfig.services.some(s=>s?.name===SERVICE)||
    !isExplicitRm68Interest(text))return {matched:false};
 const sql=[
  "WITH inbound AS MATERIALIZED (",
  " SELECT m.id,m.contact_id,m.content,m.created_at",
  " FROM messages m JOIN contacts c ON c.id=m.contact_id",
  " WHERE m.id=$2 AND m.contact_id=$1 AND m.role='user'",
  " AND c.channel='whatsapp' AND BTRIM(m.content)=BTRIM($3::text)",
  " AND m.whatsapp_message_id IS NOT NULL",
  "), current_lead AS MATERIALIZED (",
  " SELECT l.id,l.treatment_interest FROM leads l JOIN inbound i ON i.contact_id=l.contact_id",
  " WHERE l.is_closed=false AND l.created_at<=i.created_at+INTERVAL '3 minutes'",
  " ORDER BY l.created_at DESC,l.id DESC LIMIT 1",
  "), updated AS (",
  " UPDATE leads l SET treatment_interest=$4,updated_at=NOW()",
  " FROM current_lead WHERE l.id=current_lead.id",
  " AND NULLIF(BTRIM(l.treatment_interest),'') IS NULL RETURNING l.id",
  "), interest AS (",
  " INSERT INTO lead_activities (lead_id,activity_type,description,actor,metadata)",
  " SELECT current_lead.id,'updated','Customer explicitly asked about RM68 breast-care event.',",
  " 'Automation',jsonb_build_object('outcome','customer_campaign_interest',",
  " 'campaignKey',$5::text,'inboundMessageId',$2::text,'source','customer_text')",
  " FROM current_lead WHERE NOT EXISTS (",
  " SELECT 1 FROM lead_activities a WHERE a.lead_id=current_lead.id",
  " AND a.metadata->>'outcome'='customer_campaign_interest'",
  " AND a.metadata->>'inboundMessageId'=$2::text",
  " ) RETURNING id",
  ")",
  " SELECT (SELECT COUNT(*) FROM current_lead)>0 AS verified,",
  " (SELECT COUNT(*) FROM updated)>0 AS treatment_updated,",
  " (SELECT COUNT(*) FROM interest)>0 AS event_recorded",
 ].join("\n");
 const result=await database.query(sql,[
   Number(contactId),Number(messageId),String(text).trim(),SERVICE,CAMPAIGN,
 ]);
 return {matched:true,...(result.rows?.[0]||{})};
}
module.exports={CAMPAIGN,SERVICE,recordRm68CustomerInterest};