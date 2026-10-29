"use strict";
const crypto = require("node:crypto");

const ENCRYPTION_KEY_NAME = "PR395_COEXISTENCE_TOKEN_ENCRYPTION_KEY";
const PRODUCTION_ENCRYPTION_KEY_NAME = "WHATSAPP_SECONDARY_PRODUCTION_TOKEN_ENCRYPTION_KEY";
const KEY_VERSION = "v1";

// Production secrets are never accepted by QA and QA secrets are never accepted
// by production. The production vault is only for the independently verified
// second Neutro Business App number and never grants sender activation.
function productionVaultContext(env) {
  const primary=String(env.WHATSAPP_PHONE_NUMBER || "").replace(/[^0-9]/g,"");
  return env.PR395_STAGING_MODE !== "true" &&
    env.WHATSAPP_SECONDARY_PRODUCTION_VAULT_ENABLED === "true" &&
    env.WHATSAPP_PRIMARY_SENDER_KEY === "neutro" &&
    env.WHATSAPP_SECONDARY_SENDER_KEY === "neutro_secondary" &&
    env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164 === "+60174831336" &&
    /^[0-9]+$/.test(String(env.WHATSAPP_PHONE_NUMBER_ID || "")) &&
    /^[0-9]+$/.test(String(env.WHATSAPP_WABA_ID || "")) &&
    primary.length > 0 && primary !== "60174831336" &&
    String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID || "") !==
      String(env.WHATSAPP_PHONE_NUMBER_ID || "");
}
function keyFromEnv(env = process.env) {
  const staging = env.PR395_STAGING_MODE === "true" &&
    env.WHATSAPP_SECONDARY_SENDER_KEY === "coexistence_qa";
  const production = !staging && productionVaultContext(env);
  if (!staging && !production) {
    throw new Error("Coexistence vault is unavailable outside verified QA or the isolated Neutro secondary identity.");
  }
  const name = production ? PRODUCTION_ENCRYPTION_KEY_NAME : ENCRYPTION_KEY_NAME;
  const secret = String(env[name] || "").trim();
  if (production && secret === String(env[ENCRYPTION_KEY_NAME] || "").trim()) {
    throw new Error("Production Coexistence encryption key must be separate from QA.");
  }
  const key = Buffer.from(secret, "base64");
  if (!secret || key.length !== 32 || key.toString("base64") !== secret) {
    throw new Error("Coexistence credential storage requires a 32-byte base64 encryption key.");
  }
  return key;
}

function credentialVaultReady(env = process.env) {
  try { keyFromEnv(env); return true; }
  catch (_) { return false; }
}

function identity({attemptId, wabaId, phoneNumberId}) {
  const id = String(attemptId || "");
  const waba = String(wabaId || "");
  const phone = String(phoneNumberId || "");
  if (!/^\d+$/.test(id) || !/^\d+$/.test(waba) || !/^\d+$/.test(phone)) {
    throw new Error("Verified numeric onboarding attempt/account/phone identities are required.");
  }
  return Buffer.from("da-chatbot/pr395/coexistence/" + KEY_VERSION + "/" +
    id + "/" + waba + "/" + phone);
}
function sealCredential({attemptId,wabaId,phoneNumberId,accessToken,env=process.env}) {
  const key = keyFromEnv(env);
  if (typeof accessToken !== "string" || accessToken.trim().length < 10) {
    throw new Error("A real validated Meta access token is required for protected storage.");
  }
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm",key,nonce);
  cipher.setAAD(identity({attemptId,wabaId,phoneNumberId}));
  const ciphertext = Buffer.concat([cipher.update(accessToken,"utf8"),cipher.final()]);
  return {keyVersion:KEY_VERSION,nonce,ciphertext,authTag:cipher.getAuthTag()};
}
function openCredential({attemptId,wabaId,phoneNumberId,nonce,ciphertext,authTag,keyVersion,env=process.env}) {
  if(keyVersion !== KEY_VERSION) throw new Error("Unknown credential encryption key version.");
  const decipher = crypto.createDecipheriv("aes-256-gcm",keyFromEnv(env),nonce);
  decipher.setAAD(identity({attemptId,wabaId,phoneNumberId}));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString("utf8");
}

module.exports = {ENCRYPTION_KEY_NAME,PRODUCTION_ENCRYPTION_KEY_NAME,productionVaultContext,credentialVaultReady,keyFromEnv,sealCredential,openCredential};
