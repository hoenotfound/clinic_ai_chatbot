"use strict";
const crypto = require("node:crypto");

const ENCRYPTION_KEY_NAME = "PR395_COEXISTENCE_TOKEN_ENCRYPTION_KEY";
const KEY_VERSION = "v1";

function keyFromEnv(env = process.env) {
  const secret = String(env[ENCRYPTION_KEY_NAME] || "").trim();
  const key = Buffer.from(secret, "base64");
  if (!secret || key.length !== 32 || key.toString("base64") !== secret) {
    throw new Error("Coexistence credential storage requires an independently generated, 32-byte base64 encryption key.");
  }
  if (env.PR395_STAGING_MODE !== "true" ||
      env.WHATSAPP_SECONDARY_SENDER_KEY !== "coexistence_qa") {
    throw new Error("Coexistence credential vault is confined to approved personal-number staging.");
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

module.exports = {ENCRYPTION_KEY_NAME,credentialVaultReady,keyFromEnv,sealCredential,openCredential};
