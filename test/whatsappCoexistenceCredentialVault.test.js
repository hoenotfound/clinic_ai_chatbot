"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const {
  credentialVaultReady,sealCredential,openCredential
}=require("../src/services/whatsappCoexistenceCredentialVault");

const staging=(overrides={})=>({
  PR395_STAGING_MODE:"true",
  WHATSAPP_SECONDARY_SENDER_KEY:"coexistence_qa",
  PR395_COEXISTENCE_TOKEN_ENCRYPTION_KEY:crypto.randomBytes(32).toString("base64"),
  ...overrides,
});
const claim={attemptId:7,wabaId:"200000000000002",phoneNumberId:"100000000000002"};
test("coexistence vault encrypts uniquely and binds the WABA, phone and attempt ID",()=>{
  const env=staging();
  const token="meta-system-user-secret-valid-only-for-test";
  const first=sealCredential({...claim,accessToken:token,env});
  const second=sealCredential({...claim,accessToken:token,env});
  assert.equal(credentialVaultReady(env),true);
  assert.notDeepEqual(first.nonce,second.nonce);
  assert.ok(!first.ciphertext.includes(Buffer.from(token)));
  assert.notDeepEqual(first.ciphertext,second.ciphertext);
  assert.equal(openCredential({...claim,...first,env}),token);
  for(const different of [
    {...claim,attemptId:8},
    {...claim,wabaId:"200000000000003"},
    {...claim,phoneNumberId:"100000000000003"}
  ]){
    assert.throws(()=>openCredential({...different,...first,env}),/auth|authenticate|Unsupported state/i);
  }
  assert.throws(()=>openCredential({...claim,...first,
    authTag:Buffer.alloc(16),env}),/auth|authenticate|Unsupported state/i);
  assert.throws(()=>openCredential({...claim,...first,
    ciphertext:Buffer.alloc(first.ciphertext.length),env}),/auth|authenticate|Unsupported state/i);
  assert.throws(()=>openCredential({...claim,...first,
    env:staging()}),/auth|authenticate|Unsupported state/i);
  assert.equal(JSON.stringify(first).includes(token),false);
});
test("coexistence vault fails closed outside private QA or with weak/missing key",()=>{
  const env=staging();
  for(const overrides of [
    {PR395_STAGING_MODE:"false"},
    {PR395_STAGING_MODE:""},
    {WHATSAPP_SECONDARY_SENDER_KEY:"tcm_wellness"},
    {PR395_COEXISTENCE_TOKEN_ENCRYPTION_KEY:""},
    {PR395_COEXISTENCE_TOKEN_ENCRYPTION_KEY:"weak"},
    {PR395_COEXISTENCE_TOKEN_ENCRYPTION_KEY:Buffer.alloc(16).toString("base64")},
  ]){
    const unsafe={...env,...overrides};
    assert.equal(credentialVaultReady(unsafe),false);
    assert.throws(()=>sealCredential({...claim,accessToken:"synthetic-secret",env:unsafe}));
  }
  assert.throws(()=>sealCredential({...claim,accessToken:"",env}));
  assert.throws(()=>sealCredential({...claim,phoneNumberId:"not-a-number",accessToken:"synthetic-secret",env}));
});
