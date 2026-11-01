"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {normalizeSecondaryMetaToken,repairSecondaryMetaTokenInMemory}=
  require("../src/services/whatsappSecondaryMetaTokenSanitizer");
const token="EAA" + "a".repeat(98);
const env={
  WHATSAPP_SECONDARY_META_TOKEN_NORMALIZE_ENABLED:"true",
  WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575",
  WHATSAPP_SECONDARY_WABA_ID:"1852014482431209",
  WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
  WHATSAPP_SECONDARY_TOKEN:token.slice(0,40)+"\r\n  "+token.slice(40),
};
test("repairs only plausible Meta tokens with copy/paste whitespace",()=>{
  const n=normalizeSecondaryMetaToken(env.WHATSAPP_SECONDARY_TOKEN);
  assert.equal(n.status,"normalized");
  assert.equal(n.token,token);
  assert.deepEqual(normalizeSecondaryMetaToken(token),{status:"unchanged",token});
  assert.equal(normalizeSecondaryMetaToken("Bearer "+token).token,token);
  assert.equal(normalizeSecondaryMetaToken(token.slice(0,20)+"\u200B"+token.slice(20)).token,token);
  assert.equal(normalizeSecondaryMetaToken(token.slice(0,20)+"\u202e"+token.slice(20)).token,token);
  assert.equal(normalizeSecondaryMetaToken("\u201c"+token+"\u201d").token,token);
  assert.equal(normalizeSecondaryMetaToken("`"+token+"`").token,token);
  assert.equal(normalizeSecondaryMetaToken("Bearer "+token+"\n").status,"normalized");
  for (const bad of [null,123,"",token.slice(0,8),"not an access token!",
    token+"|secret",token+"\0secret",token+"☎",token+"Authorization:"]){
    assert.equal(normalizeSecondaryMetaToken(bad).token,null);
  }
});
test("explicitly gated format repair affects only secondary token, with no send",()=>{
  const input={...env,WHATSAPP_TOKEN:"primary-token-untouched"};
  const lines=[];
  const logger={info:(...a)=>lines.push(a.join(" "))};
  assert.deepEqual(repairSecondaryMetaTokenInMemory({env:input,logger}),
    {performed:true,status:"normalized"});
  assert.equal(input.WHATSAPP_SECONDARY_TOKEN,token);
  assert.equal(input.WHATSAPP_TOKEN,"primary-token-untouched");
  assert.equal(lines.length,1);
  assert.ok(!lines[0].includes(token));
  assert.ok(!lines[0].includes("primary-token-untouched"));
});
test("no implicit repair in staging, without approval or with wrong sender",()=>{
  for (const flags of [
    {WHATSAPP_SECONDARY_META_TOKEN_NORMALIZE_ENABLED:"false"},
    {PR395_STAGING_MODE:"true"},
    {WHATSAPP_SECONDARY_SENDER_KEY:"neutro"},
    {WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1408739622311791"},
  ]){
    const input={...env,...flags};
    assert.deepEqual(repairSecondaryMetaTokenInMemory({env:input,logger:{info:()=>{throw Error("must not log");}}}),{performed:false});
    assert.equal(input.WHATSAPP_SECONDARY_TOKEN,env.WHATSAPP_SECONDARY_TOKEN);
  }
});
test("invalid token formatting does not mutate secret or pretend health",()=>{
  const input={...env,WHATSAPP_SECONDARY_TOKEN:token+"\0"};
  let out;
  const result=repairSecondaryMetaTokenInMemory({env:input,
    logger:{info:(_label,json)=>{out=JSON.parse(json);}}});
  assert.deepEqual(result,{performed:true,status:"invalid"});
  assert.deepEqual(out,result);
  assert.equal(input.WHATSAPP_SECONDARY_TOKEN,token+"\0");
});
