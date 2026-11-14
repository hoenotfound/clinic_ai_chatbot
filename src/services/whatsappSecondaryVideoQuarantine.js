"use strict";
// An MP4 may pass H.264/AAC preflight and /media yet fail at Meta's
// asynchronous processing stage. A *signed*, sender-matched 131053 failure
// for the exact immutable clinic media key is enough to stop further reuse.
// This check is read-only. It never retries, releases holds or disables AI.
const SQL=`
 SELECT EXISTS (
   SELECT 1 FROM messages m
   JOIN contacts c ON c.id=m.contact_id
   JOIN whatsapp_sender_accounts sa ON sa.id=c.whatsapp_sender_id
     AND sa.id=$2 AND sa.sender_key='neutro_secondary'
     AND sa.state='active'
   JOIN whatsapp_sender_billing_attempts a
     ON a.message_id=m.id AND a.sender_id=sa.id AND a.contact_id=c.id
     AND a.wamid=m.whatsapp_message_id
   JOIN whatsapp_sender_status_receipts r
     ON r.sender_id=a.sender_id AND r.reservation_id=a.reservation_id
     AND r.wamid=a.wamid AND r.matched=TRUE
     AND r.delivery_status='failed'
     AND r.meta_phone_number_id=sa.meta_phone_number_id
     AND r.meta_account_id=sa.meta_account_id
   WHERE m.media_key=$1 AND m.media_mime_type='video/mp4'
     AND m.delivery_status='failed'
     AND m.delivery_error LIKE 'Verified Meta delivery failure (code 131053)%'
   LIMIT 1
 ) AS quarantined`;
async function isVerifiedFailedVideo({database,senderId,mediaKey,env=process.env}={}){
 if(env.WHATSAPP_SECONDARY_SENDER_KEY!=='neutro_secondary' ||
   (!Number.isSafeInteger(Number(senderId)) || Number(senderId)<=0) ||
   !/^clients\/[a-z0-9-]+\/messages\/follow-up-config\/[A-Za-z0-9._-]+\.mp4$/.test(
     String(mediaKey||'')))return false;
 const result=await database.query(SQL,[mediaKey,Number(senderId)]);
 return result.rows?.[0]?.quarantined===true;
}
// Neutral copy must never tell the customer to watch a video that we have
// deliberately withheld. Other safety checks still govern text delivery.
const TEXT=Object.freeze({
 zh:"您好 😊 如果您想继续了解之前咨询的护理，我们可以先说明护理流程和到店评估怎样安排。您比较想先了解哪一部分呢？",
 en:"Hi 😊 If you'd like to know more about the treatment you asked about, I can explain the process or how to arrange an assessment. Which would you prefer?",
 ms:"Hai 😊 Jika masih berminat dengan rawatan yang ditanya tadi, kami boleh terangkan proses rawatan atau cara mengatur penilaian. Yang mana anda nak tahu dulu?",
});
function textWithoutVideo(language){return TEXT[language]||null;}
module.exports={SQL,isVerifiedFailedVideo,textWithoutVideo};
