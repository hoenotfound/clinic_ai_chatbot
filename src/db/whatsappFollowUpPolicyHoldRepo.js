"use strict";
const { pool } = require("./db");

// Only callers with validated scheduler candidates should create a hold.
// No provider request occurs while held; the original message claim is never
// marked failed or consumed. Unique keys prevent duplicate outstanding holds.
async function defer({contactId,triggerMessageId,stepIndex,reason,delaySeconds=300}) {
  const contact=Number(contactId),anchor=Number(triggerMessageId),step=Number(stepIndex);
  const delay=Number(delaySeconds);
  if (![contact,anchor].every(n=>Number.isSafeInteger(n)&&n>0) ||
      !Number.isInteger(step)||step<1||step>3 ||
      !Number.isInteger(delay)||delay<30||delay>3600 ||
      typeof reason!=="string"||!reason||reason.length>120) {
    throw new TypeError("Invalid WhatsApp follow-up policy hold.");
  }
  const result=await pool.query(`
    INSERT INTO whatsapp_follow_up_policy_holds (
      contact_id,trigger_message_id,follow_up_step,reason,retry_at
    ) VALUES ($1,$2,$3,$4,now()+$5::integer*interval '1 second')
    ON CONFLICT (contact_id,trigger_message_id,follow_up_step)
    DO UPDATE SET reason=EXCLUDED.reason,retry_at=EXCLUDED.retry_at,
      updated_at=now()
    RETURNING retry_at
  `,[contact,anchor,step,reason,delay]);
  return result.rows[0]?.retry_at||null;
}

// Wake held follow-ups when the settings change, rather than waiting for the
// old delay. Eligibility (customer window/opt-outs/claim) is rechecked later.
async function releaseAll() {
  const result=await pool.query(`
    UPDATE whatsapp_follow_up_policy_holds
    SET retry_at=now(),updated_at=now()
    WHERE retry_at>now()
  `);
  return result.rowCount||0;
}
async function clear({contactId,triggerMessageId,stepIndex}) {
  await pool.query(`
    DELETE FROM whatsapp_follow_up_policy_holds
    WHERE contact_id=$1 AND trigger_message_id=$2 AND follow_up_step=$3
  `,[contactId,triggerMessageId,stepIndex]);
}
module.exports={defer,releaseAll,clear};
