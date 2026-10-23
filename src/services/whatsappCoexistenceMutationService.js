"use strict";
// Business App edits/deletes mutate EXISTING sender-qualified staff messages.
// Out-of-order events are durably staged and resolved after their echo appears.
// No edit/revoke ever creates a new AI reply, customer turn or Cloud API send.
const {pool}=require("../db/db");
const senderRepo=require("../db/whatsappSenderConversationRepo");

const LOOKUP_SQL=`
 SELECT j.id,j.sender_id,j.contact_id,j.action,j.replacement_text,
        m.id AS target_id
 FROM whatsapp_sender_coexistence_mutations j
 JOIN contacts c ON c.id=j.contact_id AND c.whatsapp_sender_id=j.sender_id
 JOIN whatsapp_sender_accounts sa ON sa.id=j.sender_id AND sa.state='active'
 JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
   AND sc.contact_id=c.id AND sc.state='bound'
 JOIN messages m ON m.contact_id=c.id AND m.whatsapp_message_id=j.target_wamid
   AND m.role='assistant' AND m.sent_by_username='WhatsApp Business App'
 JOIN whatsapp_sender_message_context mc ON mc.message_id=m.id
   AND mc.conversation_id=sc.id
 WHERE j.status='pending' AND j.sender_id=$1 AND j.id=$2
 FOR UPDATE OF j
`;
async function applyPending({id,senderId},{
 database=pool,
}={}){
 const client=await database.connect();
 try{
  await client.query("BEGIN");
  const match=await client.query(LOOKUP_SQL,[senderId,id]);
  if(match.rows?.length!==1){await client.query("COMMIT");return null;}
  const target=match.rows[0];
  const update=target.action==="revoke"?
    `UPDATE messages SET content='🗑️ [Message deleted from WhatsApp Business App]',
        media_key=NULL,media_url=NULL,media_mime_type=NULL
      WHERE id=$1 AND contact_id=$2
        AND sent_by_username='WhatsApp Business App' RETURNING id`
   :`UPDATE messages SET content=$3
      WHERE id=$1 AND contact_id=$2
        AND sent_by_username='WhatsApp Business App' RETURNING id`;
  const updated=await client.query(update,
    target.action==="revoke"?[target.target_id,target.contact_id]
      :[target.target_id,target.contact_id,target.replacement_text]);
  if(updated.rows?.length!==1)throw Error("Business App target changed.");
  await client.query(
    "UPDATE whatsapp_sender_coexistence_mutations SET status='applied',target_message_id=$2,updated_at=NOW() WHERE id=$1 AND status='pending'",
    [id,target.target_id]
  );
  await client.query("COMMIT");
  return{messageId:target.target_id,contactId:target.contact_id};
 }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}
 finally{client.release();}
}
async function record(echo,contact,{
 database=pool,env=process.env,conversations=senderRepo,
}={}){
 if(!["edit","revoke"].includes(echo?.type))return null;
 if(!/^wamid\.[A-Za-z0-9._:-]+$/.test(String(echo?.id||"")) ||
    !/^wamid\.[A-Za-z0-9._:-]+$/.test(String(echo?.originalMessageId||"")) ||
    (echo.type==="edit" && (!String(echo.text||"").trim() ||
      String(echo.text).length>4096))) {
   throw Error("Unsupported WhatsApp Business App edit/revoke payload.");
 }
 const owner=await conversations.senderForContact(contact.id,database);
 if(!owner||owner.sender_key!==env.WHATSAPP_SECONDARY_SENDER_KEY ||
    owner.meta_phone_number_id!==env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID ||
    owner.meta_account_id!==env.WHATSAPP_SECONDARY_WABA_ID ||
    contact.whatsapp_number!==owner.customer_wa_id)
   throw Error("Business App mutation sender mismatch.");
 const row=await database.query(
   `INSERT INTO whatsapp_sender_coexistence_mutations
      (sender_id,contact_id,event_wamid,target_wamid,action,replacement_text)
    VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(sender_id,event_wamid) DO UPDATE
      SET event_wamid=EXCLUDED.event_wamid
    WHERE whatsapp_sender_coexistence_mutations.contact_id=EXCLUDED.contact_id
      AND whatsapp_sender_coexistence_mutations.target_wamid=EXCLUDED.target_wamid
      AND whatsapp_sender_coexistence_mutations.action=EXCLUDED.action
      AND whatsapp_sender_coexistence_mutations.replacement_text
          IS NOT DISTINCT FROM EXCLUDED.replacement_text
    RETURNING id,status`,
   [owner.sender_id,contact.id,echo.id,echo.originalMessageId,
    echo.type,echo.type==="edit"?echo.text:null]
 );
 if(row.rows?.length!==1)throw Error("Business App mutation replay conflicts.");
 if(row.rows[0].status==="applied")return{alreadyApplied:true};
 return applyPending({id:row.rows[0].id,senderId:owner.sender_id},{database});
}
async function runOnce({database=pool,env=process.env,limit=20}={}){
 if(env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED!=="true")
   return{disabled:true};
 const owner=await database.query(
   "SELECT id FROM whatsapp_sender_accounts WHERE sender_key=$1 AND meta_phone_number_id=$2 "+
   "AND meta_account_id=$3 AND state='active'",
   [env.WHATSAPP_SECONDARY_SENDER_KEY,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
    env.WHATSAPP_SECONDARY_WABA_ID]
 );
 if(owner.rows?.length!==1)return{disabled:true};
 const senderId=owner.rows[0].id;
 await database.query(
   "UPDATE whatsapp_sender_coexistence_mutations SET status='expired',updated_at=NOW() "+
   "WHERE sender_id=$1 AND status='pending' AND created_at<NOW()-INTERVAL '7 days'",
   [senderId]
 );
 const pending=await database.query(
   "SELECT id FROM whatsapp_sender_coexistence_mutations WHERE sender_id=$1 "+
   "AND status='pending' ORDER BY created_at LIMIT $2",
   [senderId,Math.max(1,Math.min(30,Number(limit)||20))]
 );
 let applied=0;
 for(const job of pending.rows||[]){
   if(await applyPending({id:job.id,senderId},{database}))applied++;
 }
 return{disabled:false,applied};
}
let timer=null;
function start({env=process.env,setIntervalFn=setInterval}={}){
 if(env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED!=="true"||timer)return false;
 timer=setIntervalFn(()=>runOnce({env}).catch(e=>
   console.error("[Business App mutation] recovery failed:",e?.message)),60000);
 timer?.unref?.();return true;
}
function stop(){if(timer){clearInterval(timer);timer=null;}}
module.exports={LOOKUP_SQL,record,applyPending,runOnce,start,stop};
