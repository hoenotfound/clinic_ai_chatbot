const {pool}=require("./db");

// Record only an actual WhatsApp inbound with ad referral data. Never infer
// a session from the contact's first-touch record, ad name, or an old ad.
async function recordIfQualifying(contactId, messageId, attribution, database=pool) {
  if (!Number.isSafeInteger(Number(contactId)) || !Number.isSafeInteger(Number(messageId)) ||
      !attribution || attribution.source !== "meta_ads" ||
      String(attribution.sourceType || "").toLowerCase() !== "ad") return false;
  const ctwa = String(attribution.ctwaClid || "").trim() || null;
  const adId = String(attribution.adId || "").trim() || null;
  if (!ctwa && !adId) return false;
  const result=await database.query(
    `INSERT INTO whatsapp_free_entry_referrals
       (origin_message_id,contact_id,ctwa_clid,meta_ad_id,source_type)
     VALUES ($1,$2,$3,$4,'ad')
     ON CONFLICT (origin_message_id) DO NOTHING
     RETURNING origin_message_id`,
    [Number(messageId),Number(contactId),ctwa,adId]
  );
  return result.rowCount===1;
}

module.exports={recordIfQualifying};
