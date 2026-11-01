"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {
  enabled,safeNetworkCause,probeSecondaryMetaConnectivity,
}=require("../src/services/whatsappSecondaryMetaReadOnlyProbe");
const env={
  WHATSAPP_SECONDARY_META_READONLY_PROBE_ON_BOOT:"true",
  WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575",
  WHATSAPP_SECONDARY_WABA_ID:"1852014482431209",
  WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
  WHATSAPP_SECONDARY_TOKEN:"sample-secret-do-not-log",
};
function logger(){
  const entries=[];
  return {entries,warn:(...args)=>entries.push(args.join(" "))};
}
test("read-only probe stays disabled by default and refuses a mismatched sender",async()=>{
  let calls=0;
  const fetchImpl=async()=>{calls++;throw new Error("no");};
  for (const overrides of [
    {WHATSAPP_SECONDARY_META_READONLY_PROBE_ON_BOOT:"false"},
    {WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1408739622311791"},
    {WHATSAPP_SECONDARY_WABA_ID:"wrong"},
    {WHATSAPP_SECONDARY_SENDER_KEY:"neutro"},
    {PR395_STAGING_MODE:"true"},
  ]){
    const res=await probeSecondaryMetaConnectivity({
      env:{...env,...overrides},fetchImpl,logger:logger(),
    });
    assert.deepEqual(res,{performed:false,sendAuthorized:false});
  }
  assert.equal(calls,0);
  assert.equal(enabled(env),true);
});
test("one read-only Graph GET logs only status, never body or token",async()=>{
  let calls=0;
  const logs=logger();
  const result=await probeSecondaryMetaConnectivity({
    env,logger:logs,fetchImpl:async(url,opts)=>{
      calls++;
      assert.equal(url,"https://graph.facebook.com/v26.0/1318355951360575?fields=id");
      assert.equal(opts.method,"GET");
      assert.equal(opts.body,undefined);
      assert.equal(opts.headers.Authorization,"Bearer "+env.WHATSAPP_SECONDARY_TOKEN);
      return {status:403,ok:false,text:async()=>{throw new Error("MUST NOT READ");}};
    },
  });
  assert.deepEqual(result,{performed:true,kind:"http_response",httpStatus:403,sendAuthorized:false});
  assert.equal(calls,1);
  assert.equal(logs.entries.length,1);
  assert.ok(!logs.entries[0].includes(env.WHATSAPP_SECONDARY_TOKEN));
  assert.ok(!logs.entries[0].includes("MUST NOT READ"));
});
test("network cause is allowlisted and raw failure bodies never appear",async()=>{
  const logs=logger();
  const secret="private-token-should-not-leak";
  const err=new TypeError("fetch failed "+secret,{cause:Object.assign(new Error("TLS "+secret),{code:"UNABLE_TO_GET_ISSUER_CERT_LOCALLY"})});
  const result=await probeSecondaryMetaConnectivity({env,logger:logs,
    fetchImpl:async()=>{throw err;}});
  assert.equal(result.kind,"transport_error");
  assert.equal(result.causeCode,"UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
  assert.equal(logs.entries.length,1);
  assert.ok(!logs.entries[0].includes(secret));
  assert.ok(!logs.entries[0].includes(env.WHATSAPP_SECONDARY_TOKEN));
  assert.equal(safeNetworkCause({code:"ENOTFOUND"}),"ENOTFOUND");
  assert.equal(safeNetworkCause({code:"secret-huge-unexpected-code"}),"unidentified");
});
test("malformed Authorization never touches network and cannot log credential",async()=>{
  const logs=logger();
  let calls=0;
  const res=await probeSecondaryMetaConnectivity({
    env:{...env,WHATSAPP_SECONDARY_TOKEN:"bad\r\nHeader: secret"},
    logger:logs,fetchImpl:async()=>{calls++;},
  });
  assert.equal(res.kind,"invalid_auth_header");
  assert.equal(calls,0);
  assert.equal(logs.entries.length,1);
  assert.ok(!logs.entries[0].includes("Header: secret"));
});
test("missing token is non-sending diagnostic, never a failure to start app",async()=>{
  const logs=logger();
  let calls=0;
  const res=await probeSecondaryMetaConnectivity({
    env:{...env,WHATSAPP_SECONDARY_TOKEN:""},
    logger:logs,fetchImpl:async()=>{calls++;},
  });
  assert.equal(res.kind,"credential_missing");
  assert.equal(res.sendAuthorized,false);
  assert.equal(calls,0);
});
