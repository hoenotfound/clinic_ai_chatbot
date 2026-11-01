"use strict";

// ONE read-only Graph GET from the live service, operator enabled for debugging.
// No messages, templates, media, contacts, resends, DB writes or tokens in logs.
const { validateHeaderValue } = require("node:http");
const CONNECT_MS = 6000;
const ALLOWED_CODES = new Set([
  "ENOTFOUND","EAI_AGAIN","ECONNRESET","ECONNREFUSED","ETIMEDOUT",
  "ENETUNREACH","EHOSTUNREACH","EPIPE","UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT","UND_ERR_BODY_TIMEOUT","UND_ERR_SOCKET",
  "ERR_INVALID_CHAR","ERR_HTTP_INVALID_HEADER_VALUE",
  "ERR_INVALID_HTTP_TOKEN","ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE","UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN","CERT_HAS_EXPIRED",
]);
function safeNetworkCause(error) {
  const candidates=[error?.code,error?.cause?.code,
    ...(Array.isArray(error?.cause?.errors)
      ? error.cause.errors.slice(0,4).map(e=>e?.code) : [])];
  return candidates.find(code=>typeof code==="string" && ALLOWED_CODES.has(code)) || "unidentified";
}
function enabled(env=process.env) {
  return env.WHATSAPP_SECONDARY_META_READONLY_PROBE_ON_BOOT==="true" &&
    env.WHATSAPP_SECONDARY_SENDER_KEY==="neutro_secondary" &&
    env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID==="1318355951360575" &&
    env.WHATSAPP_SECONDARY_WABA_ID==="1852014482431209" &&
    env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID!==env.WHATSAPP_PHONE_NUMBER_ID &&
    env.PR395_STAGING_MODE!=="true";
}
async function probeSecondaryMetaConnectivity({
  env=process.env,fetchImpl=global.fetch,logger=console,timeoutMs=CONNECT_MS,
}={}) {
  if (!enabled(env)) return {performed:false,sendAuthorized:false};
  const token=String(env.WHATSAPP_SECONDARY_TOKEN||"").trim();
  if(!token || typeof fetchImpl!=="function") {
    const state={performed:true,kind:"credential_missing",sendAuthorized:false};
    logger.warn("[Secondary WhatsApp read-only Meta probe]",JSON.stringify(state));
    return state;
  }
  try {
    validateHeaderValue("Authorization","Bearer "+token);
  } catch {
    const state={performed:true,kind:"invalid_auth_header",sendAuthorized:false};
    logger.warn("[Secondary WhatsApp read-only Meta probe]",JSON.stringify(state));
    return state;
  }
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  let state;
  try {
    // GET only. A permissions error still proves the network/TLS path works;
    // querying a phone object can require additional permissions beyond sending.
    const response=await fetchImpl(
      "https://graph.facebook.com/v26.0/1318355951360575?fields=id",
      {method:"GET",headers:{Authorization:"Bearer "+token},signal:controller.signal}
    );
    // Do not read or log provider response body, WABA details or credentials.
    state={performed:true,kind:"http_response",
      httpStatus:Number.isInteger(response?.status)?response.status:null,
      sendAuthorized:false};
    return state;
  } catch(error) {
    state={performed:true,kind:controller.signal.aborted?"timeout":"transport_error",
      causeCode:safeNetworkCause(error),sendAuthorized:false};
    return state;
  } finally {
    clearTimeout(timer);
    logger.warn("[Secondary WhatsApp read-only Meta probe]",JSON.stringify(state));
  }
}
module.exports={enabled,safeNetworkCause,probeSecondaryMetaConnectivity};
