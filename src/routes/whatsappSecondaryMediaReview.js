"use strict";
// Read-only staff evidence. DO NOT expose a "retry" button for Cloud API sends:
// a claimed/unknown secondary message may already have been accepted by Meta.
const express=require("express");
const {pool}=require("../db/db");
const {hasCapability}=require("../utils/permissions");
const router=express.Router();
router.get("/",async(req,res)=>{
 if(!hasCapability(req.user,"manage_tools"))
   return res.status(403).json({error:"Manage Tools permission required."});
 res.set("Cache-Control","no-store");
 if(process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED!=="true" ||
    process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED!=="true")
   return res.json({configured:false,items:[]});
 try{
   const lookup=await pool.query(
     "SELECT id,display_name FROM whatsapp_sender_accounts WHERE sender_key=$1 AND meta_phone_number_id=$2 "+
     "AND meta_account_id=$3 AND state='active'",
     [process.env.WHATSAPP_SECONDARY_SENDER_KEY,
      process.env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
      process.env.WHATSAPP_SECONDARY_WABA_ID]
   );
   if(lookup.rows?.length!==1)return res.json({configured:false,items:[]});
   const senderId=lookup.rows[0].id;
   const [outbound,inbound,history,followups]=await Promise.all([
     pool.query(
       `SELECT 'outbound_ai_image' AS type,j.id::text AS id,j.contact_id,
          j.outbound_message_id AS message_id,j.state AS status,
          j.media_kind,j.created_at,j.updated_at,
          COALESCE(m.delivery_status,CASE WHEN j.state='expired' THEN 'not_sent' ELSE 'unknown' END) AS delivery_status,
          CASE WHEN j.state='expired'
            THEN 'Queued image expired before a verified provider send. Check the conversation and any staff-shared images. If still relevant, staff may send a fresh image manually.'
            ELSE 'Verify message acceptance and signed billing receipts in Meta; never automatically resend' END AS action
        FROM whatsapp_sender_ai_media_jobs j
        LEFT JOIN messages m ON m.id=j.outbound_message_id
        WHERE j.sender_id=$1 AND (j.state='unknown'
          OR (j.state='claimed' AND j.updated_at<NOW()-INTERVAL '5 minutes')
          OR (j.state='expired' AND j.updated_at>=NOW()-INTERVAL '14 days'
            AND (j.outbound_message_id IS NULL
              OR (m.whatsapp_message_id IS NULL AND m.whatsapp_accepted_at IS NULL))))
        ORDER BY j.updated_at DESC LIMIT 50`,[senderId]
     ),
     pool.query(
       `SELECT 'business_app_attachment' AS type,j.message_id::text AS id,
           j.contact_id,j.message_id,j.status,j.created_at,j.updated_at,
           'accepted_on_phone' AS delivery_status,
           'Media sent from the Business App; download failed. Check the original WhatsApp chat and the saved placeholder' AS action
        FROM whatsapp_sender_coexistence_media_jobs j
        WHERE j.sender_id=$1 AND (j.status='review'
          OR (j.status='claimed' AND j.updated_at<NOW()-INTERVAL '10 minutes'))
        ORDER BY j.updated_at DESC LIMIT 50`,[senderId]
     ),
     pool.query(
       `SELECT 'business_app_history' AS type,fingerprint AS id,
           NULL::integer AS contact_id,NULL::integer AS message_id,
           status,created_at,updated_at,'passive_import' AS delivery_status,
           COALESCE(last_error,'History import expired without processing') AS action
        FROM whatsapp_sender_coexistence_import_jobs
        WHERE sender_id=$1 AND status IN('failed','expired')
        ORDER BY updated_at DESC LIMIT 50`,[senderId]
     ),
     // Unknown secondary follow-up outcomes are a staff check, not retry work.
     // The query is read-only and exact sender-scoped, including marketing slots.
     pool.query(
       `SELECT f.type, f.id::text AS id, f.contact_id, f.message_id,
           f.status, f.claimed_at AS created_at,
           COALESCE(f.completed_at,f.claimed_at) AS updated_at,
           COALESCE(m.delivery_status,'unconfirmed') AS delivery_status,
           'Check the original chat and Meta delivery/billing receipts. Do not retry a blocked or unknown follow-up.' AS action
         FROM (
           SELECT 'outbound_followup' AS type,id,contact_id,message_id,
             sender_id,status,claimed_at,completed_at
           FROM whatsapp_sender_followup_attempts
           UNION ALL
           SELECT 'outbound_marketing_followup' AS type,id,contact_id,message_id,
             sender_id,status,claimed_at,completed_at
           FROM whatsapp_sender_marketing_followup_attempts
         ) f
         LEFT JOIN messages m ON m.id=f.message_id AND m.contact_id=f.contact_id
         WHERE f.sender_id=$1 AND f.status IN('unknown','blocked')
           AND f.claimed_at>=NOW()-INTERVAL '14 days'
         ORDER BY updated_at DESC LIMIT 50`,[senderId]
     ),
   ]);
   return res.json({configured:true,senderDisplayName:lookup.rows[0].display_name,items:[...outbound.rows,...inbound.rows,...history.rows,...followups.rows]
     .sort((a,b)=>new Date(b.updated_at)-new Date(a.updated_at)),
    outboundRetryAllowed:false});
 }catch(e){
   console.error("secondary sender media review unavailable:",e?.message);
   return res.status(503).json({error:"secondary media review cannot be verified."});
 }
});
module.exports=router;
