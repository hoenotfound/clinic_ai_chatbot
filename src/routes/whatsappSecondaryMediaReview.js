"use strict";
// Read-only staff evidence. DO NOT expose a "retry" button for Cloud API sends:
// a claimed/unknown Ariel message may already have been accepted by Meta.
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
     "SELECT id FROM whatsapp_sender_accounts WHERE sender_key=$1 AND meta_phone_number_id=$2 "+
     "AND meta_account_id=$3 AND state='active'",
     [process.env.WHATSAPP_SECONDARY_SENDER_KEY,
      process.env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
      process.env.WHATSAPP_SECONDARY_WABA_ID]
   );
   if(lookup.rows?.length!==1)return res.json({configured:false,items:[]});
   const senderId=lookup.rows[0].id;
   const [outbound,inbound]=await Promise.all([
     pool.query(
       `SELECT 'outbound_ai_image' AS type,j.id::text AS id,j.contact_id,
          j.outbound_message_id AS message_id,j.state AS status,
          j.created_at,j.updated_at,
          COALESCE(m.delivery_status,'unknown') AS delivery_status,
          'Verify message acceptance and signed billing receipts in Meta; never automatically resend' AS action
        FROM whatsapp_sender_ai_media_jobs j
        LEFT JOIN messages m ON m.id=j.outbound_message_id
        WHERE j.sender_id=$1 AND (j.state='unknown'
          OR (j.state='claimed' AND j.updated_at<NOW()-INTERVAL '5 minutes'))
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
   ]);
   return res.json({configured:true,items:[...outbound.rows,...inbound.rows]
     .sort((a,b)=>new Date(b.updated_at)-new Date(a.updated_at)),
    outboundRetryAllowed:false});
 }catch(e){
   console.error("Ariel sender media review unavailable:",e?.message);
   return res.status(503).json({error:"Ariel media review cannot be verified."});
 }
});
module.exports=router;
