const { pool } = require("./db");
const {sealCredential,openCredential,keyFromEnv} = require("../services/whatsappCoexistenceCredentialVault");

function text(value, max = 1000) {
  const cleaned = String(value || "").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

async function recordValidated({
  wabaId,
  phoneNumberId,
  displayPhoneNumber = null,
  verifiedName = null,
  coexistenceReady = false,
  eventVersion = null,
  tokenExpiresAt = null,
  startedBy = null,
} = {}) {
  const result = await pool.query(
    `INSERT INTO whatsapp_coexistence_onboarding_attempts (
       status, waba_id, phone_number_id, display_phone_number, verified_name,
       coexistence_ready, event_version, token_expires_at, started_by
     )
     VALUES ('validated', $1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      text(wabaId, 128),
      text(phoneNumberId, 128),
      text(displayPhoneNumber, 128),
      text(verifiedName, 256),
      coexistenceReady === true,
      Number.isInteger(Number(eventVersion)) ? Number(eventVersion) : null,
      tokenExpiresAt || null,
      text(startedBy, 128),
    ]
  );
  return result.rows[0] || null;
}

// The one-time Embedded Signup code is already consumed when we reach this
// function. Store its verified token in the SAME transaction as the audit:
// a failed vault write must never appear as a validated onboarding.
async function recordValidatedWithCredential({
  wabaId,phoneNumberId,displayPhoneNumber=null,verifiedName=null,
  coexistenceReady=false,eventVersion=null,tokenExpiresAt=null,
  startedBy=null,accessToken,tokenNonExpiring=false,
}={}, {database=pool,env=process.env}={}) {
  keyFromEnv(env);
  const waba=text(wabaId,128),phone=text(phoneNumberId,128);
  if(!/^\d+$/.test(waba||"") || !/^\d+$/.test(phone||"") ||
     waba===String(env.WHATSAPP_WABA_ID||"") ||
     phone===String(env.WHATSAPP_PHONE_NUMBER_ID||"")) {
    throw new Error("Refusing to vault an unverified, primary, or cross-account WhatsApp sender.");
  }
  // PostgreSQL's native timestamptz 'infinity' preserves the actual token
  // semantics without inventing a future expiry date or changing schema 103.
  // Only an explicitly Meta-attested expires_at=0 can request this path.
  if(tokenNonExpiring!==true && tokenNonExpiring!==false)
    throw new Error("Invalid Meta credential expiration proof.");
  if(tokenNonExpiring && tokenExpiresAt!=null)
    throw new Error("Conflicting permanent and expiring Meta credential proof.");
  const expiry=tokenNonExpiring?null:new Date(tokenExpiresAt||"");
  if(!tokenNonExpiring &&
     (!Number.isFinite(expiry.getTime()) || expiry.getTime()<=Date.now())) {
    throw new Error("Valid future token expiry is required for Coexistence credentials.");
  }
  const expiryValue=tokenNonExpiring?"infinity":expiry.toISOString();
  const client=await database.connect();
  let active=false;
  try {
    await client.query("BEGIN");active=true;
    const saved=await client.query(
      `INSERT INTO whatsapp_coexistence_onboarding_attempts (
        status,waba_id,phone_number_id,display_phone_number,verified_name,
        coexistence_ready,event_version,token_expires_at,started_by)
        VALUES ('validated',$1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [waba,phone,text(displayPhoneNumber,128),text(verifiedName,256),
        coexistenceReady===true,
        Number.isInteger(Number(eventVersion))?Number(eventVersion):null,
        expiryValue,text(startedBy,128)]
    );
    const attempt=saved.rows?.[0];
    if(!attempt?.id)throw new Error("Coexistence audit insert did not return an attempt.");
    const sealed=sealCredential({
      attemptId:attempt.id,wabaId:waba,phoneNumberId:phone,accessToken,env
    });
    await client.query(
      `INSERT INTO whatsapp_coexistence_onboarding_credentials (
        attempt_id,waba_id,phone_number_id,key_version,nonce,ciphertext,
        auth_tag,token_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [attempt.id,waba,phone,sealed.keyVersion,sealed.nonce,
        sealed.ciphertext,sealed.authTag,expiryValue]
    );
    await client.query("COMMIT");active=false;
    return attempt;
  }catch(error){
    if(active)await client.query("ROLLBACK").catch(()=>{});
    // Never propagate a database exception that might include SQL parameters.
    throw new Error("Verified Coexistence credential could not be saved securely.",{cause:error});
  }finally{client.release();}
}

// INTERNAL SERVER-SIDE ONLY. Callers must pass BOTH verified sender IDs.
// No frontend route returns this token, and the service NEVER sends a
// message or changes a Meta subscription when a token is retrieved.
async function loadValidatedCredentialForSetup({
  wabaId,phoneNumberId,
}={}, {database=pool,env=process.env,now=new Date()}={}) {
  keyFromEnv(env);
  const waba=text(wabaId,128),phone=text(phoneNumberId,128);
  if(!/^\d+$/.test(waba||"") || !/^\d+$/.test(phone||"") ||
     waba===String(env.WHATSAPP_WABA_ID||"") ||
     phone===String(env.WHATSAPP_PHONE_NUMBER_ID||"")) {
    throw new Error("Only a separate, verified QA sender may use the credential vault.");
  }
  const result=await database.query(
    `SELECT c.attempt_id,c.waba_id,c.phone_number_id,c.key_version,
       c.nonce,c.ciphertext,c.auth_tag,c.token_expires_at
     FROM whatsapp_coexistence_onboarding_credentials c
     JOIN whatsapp_coexistence_onboarding_attempts a ON a.id=c.attempt_id
     WHERE c.waba_id=$1 AND c.phone_number_id=$2
       AND a.status='validated' AND a.waba_id=$1 AND a.phone_number_id=$2
       AND c.token_expires_at>$3
     ORDER BY c.attempt_id DESC LIMIT 1`,
    [waba,phone,new Date(now).toISOString()]
  );
  const row=result.rows?.[0];
  if(!row)throw new Error("No valid unexpired authorized credential exists for this QA sender.");
  return {
    accessToken:openCredential({
      attemptId:row.attempt_id,wabaId:waba,phoneNumberId:phone,
      nonce:row.nonce,ciphertext:row.ciphertext,authTag:row.auth_tag,
      keyVersion:row.key_version,env
    }),
    wabaId:waba,phoneNumberId:phone,
    expiresAt:row.token_expires_at===Infinity || row.token_expires_at==="infinity"
      ? null : row.token_expires_at,
    nonExpiring:row.token_expires_at===Infinity || row.token_expires_at==="infinity",
  };
}

async function recordFailed({
  wabaId = null,
  eventVersion = null,
  errorCode = null,
  errorMessage = null,
  startedBy = null,
} = {}) {
  const result = await pool.query(
    `INSERT INTO whatsapp_coexistence_onboarding_attempts (
       status, waba_id, event_version, error_code, error_message, started_by
     )
     VALUES ('failed', $1, $2, $3, $4, $5)
     RETURNING *`,
    [
      text(wabaId, 128),
      Number.isInteger(Number(eventVersion)) ? Number(eventVersion) : null,
      text(errorCode, 128),
      text(errorMessage, 1000),
      text(startedBy, 128),
    ]
  );
  return result.rows[0] || null;
}

async function getLatest() {
  const result = await pool.query(
    `SELECT id, status, waba_id, phone_number_id, display_phone_number,
            verified_name, coexistence_ready, event_version, token_expires_at,
            error_code, error_message, started_by, created_at
     FROM whatsapp_coexistence_onboarding_attempts
     ORDER BY created_at DESC, id DESC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

module.exports = {
  getLatest,
  recordFailed,
  recordValidated,
  recordValidatedWithCredential,
  loadValidatedCredentialForSetup,
};
