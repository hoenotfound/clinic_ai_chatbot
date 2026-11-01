"use strict";

// Only remove accidental copy/paste whitespace and invisible Unicode format
// marks from a plausible Meta bearer token. Never log or return credential
// bytes in diagnostics; never relax TLS or retry an unknown POST.
const {validateHeaderValue}=require("node:http");
const {enabled}=require("./whatsappSecondaryMetaReadOnlyProbe");

function normalizeSecondaryMetaToken(raw){
  if(typeof raw!=="string") return {status:"invalid",token:null};
  const value=raw.trim();
  // A pasted "Bearer <token>" is not itself the token. Strip at most one
  // such prefix; other arbitrary strings will fail the ASCII character check.
  const unprefixed=/^Bearer\s+/i.test(value)
    ? value.replace(/^Bearer\s+/i,"") : value;
  const candidate=unprefixed.replace(/[\s\u200B-\u200D\uFEFF]/g,"");
  if(!/^[A-Za-z0-9._~+\/=\-]{30,4096}$/.test(candidate)) {
    return {status:"invalid",token:null};
  }
  try{validateHeaderValue("Authorization","Bearer "+candidate);}
  catch{return {status:"invalid",token:null};}
  return {status:candidate===value?"unchanged":"normalized",token:candidate};
}

function repairSecondaryMetaTokenInMemory({
  env=process.env,logger=console,
}={}){
  if(!enabled({...env,WHATSAPP_SECONDARY_META_READONLY_PROBE_ON_BOOT:"true"}) ||
      env.WHATSAPP_SECONDARY_META_TOKEN_NORMALIZE_ENABLED!=="true"){
    return {performed:false};
  }
  const result=normalizeSecondaryMetaToken(env.WHATSAPP_SECONDARY_TOKEN);
  // Senders remain subject to all normal authorization/billing/audience gates.
  if(result.token && result.status==="normalized"){
    env.WHATSAPP_SECONDARY_TOKEN=result.token;
  }
  const state={performed:true,status:result.status};
  logger.info("[Secondary WhatsApp token format]",JSON.stringify(state));
  return state;
}
module.exports={normalizeSecondaryMetaToken,repairSecondaryMetaTokenInMemory};
