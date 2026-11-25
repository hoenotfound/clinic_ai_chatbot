"use strict";
const {pool}=require("./db");
const {isExplicitRm68Interest,isRm68ClinicalConcern}=require("../utils/neutroRm68InterestEvidence");
const CAMPAIGN="neutro_breast_rm68_2026";
// This campaign describes an event, NOT the separately configured herbal
// breast-care treatment. Never overwrite lead treatment or booked services.
async function recordRm68CustomerInterest({contactId,messageId,text,clinicConfig,database=pool}={}){
 if(!Number.isSafeInteger(Number(contactId))||Number(contactId)<1||
    !Number.isSafeInteger(Number(messageId))||Number(messageId)<1||
    clinicConfig?.businessType!=="tcm_clinic"||
    !/^neutro\s+sense\s+tcm(?:\s+centre)?$/iu.test(
      String(clinicConfig?.businessName||clinicConfig?.clinicName||"").trim())||
    !isExplicitRm68Interest(text))return {matched:false};
 const sql=[
  "WITH inbound AS MATERIALIZED (",
  " SELECT m.id,m.contact_id,m.content,m.created_at",
  " FROM messages m JOIN contacts c ON c.id=m.contact_id",
  " WHERE m.id=$2 AND m.contact_id=$1 AND m.role='user'",
  " AND c.channel='whatsapp' AND BTRIM(m.content)=BTRIM($3::text)",
  " AND m.whatsapp_message_id IS NOT NULL",
  "), current_lead AS MATERIALIZED (",
  " SELECT l.id FROM leads l JOIN inbound i ON i.contact_id=l.contact_id",
  " WHERE l.is_closed=false AND l.created_at<=i.created_at+INTERVAL '3 minutes'",
  " ORDER BY l.created_at DESC,l.id DESC LIMIT 1",
  "), interest AS (",
  " INSERT INTO lead_activities (lead_id,activity_type,description,actor,metadata)",
  " SELECT current_lead.id,'updated','Customer explicitly asked about RM68 breast-care event.',",
  " 'Automation',jsonb_build_object('outcome','customer_campaign_interest',",
  " 'campaignKey',$4::text,'inboundMessageId',$2::text,'source','customer_text',",
  " 'medicalReviewNeeded',$5::boolean)",
  " FROM current_lead WHERE NOT EXISTS (",
  " SELECT 1 FROM lead_activities a WHERE a.lead_id=current_lead.id",
  " AND a.metadata->>'outcome'='customer_campaign_interest'",
  " AND a.metadata->>'inboundMessageId'=$2::text",
  " ) RETURNING id",
  ")",
  " SELECT (SELECT COUNT(*) FROM current_lead)>0 AS verified,",
  " (SELECT COUNT(*) FROM interest)>0 AS event_recorded",
 ].join("\n");
 const result=await database.query(sql,[
   Number(contactId),Number(messageId),String(text).trim(),CAMPAIGN,
   isRm68ClinicalConcern(text),
 ]);
 return {matched:true,...(result.rows?.[0]||{})};
}
module.exports={CAMPAIGN,recordRm68CustomerInterest};
