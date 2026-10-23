#!/usr/bin/env node
"use strict";
require("dotenv").config();

const { loadRuntimeEnv } = require("./checkWhatsAppCoexistenceStatus");
const { verifyWhatsAppSenderMapping } = require("../src/provisioning/whatsappSenderVerification");

function numeric(v) { return /^[0-9]+$/.test(String(v || "").trim()); }
function validateDistinctSenders(env) {
  const primary = String(env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  const secondary = String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID || "").trim();
  const primaryAccount = String(env.WHATSAPP_WABA_ID || "").trim();
  const secondaryAccount = String(env.WHATSAPP_SECONDARY_WABA_ID || "").trim();
  const appId = String(env.META_APP_ID || "").trim();
  if (![primary, secondary, primaryAccount, secondaryAccount, appId].every(numeric) ||
      primary === secondary || !env.WHATSAPP_PRIMARY_SENDER_KEY ||
      !env.WHATSAPP_SECONDARY_SENDER_KEY ||
      env.WHATSAPP_PRIMARY_SENDER_KEY === env.WHATSAPP_SECONDARY_SENDER_KEY) {
    throw new Error("Two distinct verified sender phone IDs/keys and numeric Meta account/app IDs are required.");
  }
  return {primary, secondary, primaryAccount, secondaryAccount, appId};
}

async function verifyDualSenderMapping({
  env, clientBaseUrl, primaryToken, secondaryToken, fetchImpl = global.fetch,
}) {
  const ids=validateDistinctSenders(env);
  if (!primaryToken || !secondaryToken) {
    throw new Error("Separate primary and secondary read-only verification tokens are required.");
  }
  // Never use a primary token to look up a secondary number or infer sender ownership.
  const [primary,secondary]=await Promise.all([
    verifyWhatsAppSenderMapping({
      wabaId:ids.primaryAccount,phoneNumberId:ids.primary,appId:ids.appId,
      clientBaseUrl,accessToken:primaryToken,fetchImpl,
    }),
    verifyWhatsAppSenderMapping({
      wabaId:ids.secondaryAccount,phoneNumberId:ids.secondary,appId:ids.appId,
      clientBaseUrl,accessToken:secondaryToken,fetchImpl,
      requireCoexistence:true,
    }),
  ]);
  return {
    verified:primary.verified===true && secondary.verified===true,
    primary,secondary,
    sameMetaAccount:ids.primaryAccount===ids.secondaryAccount,
    // No tokens, raw Graph payloads, or env secrets are returned.
  };
}
function parseArgs(argv) {
  const args={};
  for(let i=0;i<argv.length;i++){
    if(argv[i]==="--help"||argv[i]==="-h"){args.help=true;continue;}
    if(argv[i]!=="--runtime-env-file"&&argv[i]!=="--client-url"){
      throw new Error("Unsupported option. Do not provide tokens on the command line.");
    }
    const key=argv[i]==="--runtime-env-file"?"runtimeEnvFile":"clientUrl";
    const value=argv[++i];
    if(!value || value.startsWith("--"))throw new Error("Missing option value.");
    args[key]=value;
  }
  return args;
}
async function main(){
  try {
    const args=parseArgs(process.argv.slice(2));
    if(args.help){
      console.log("READ-ONLY: node scripts/verifyWhatsAppDualSenderMapping.js --runtime-env-file ./staging.env --client-url https://your-staging-domain");
      return;
    }
    if(!args.runtimeEnvFile||!args.clientUrl)throw new Error("Staging env file and client URL are required.");
    const env=loadRuntimeEnv(args.runtimeEnvFile);
    const report=await verifyDualSenderMapping({
      env,clientBaseUrl:args.clientUrl,
      primaryToken:String(process.env.WHATSAPP_MANAGEMENT_TOKEN||env.WHATSAPP_TOKEN||"").trim(),
      secondaryToken:String(process.env.WHATSAPP_SECONDARY_MANAGEMENT_TOKEN||
        env.WHATSAPP_SECONDARY_TOKEN||"").trim(),
    });
    console.log(JSON.stringify(report,null,2));
    if(!report.verified)process.exitCode=2;
  } catch(e){
    console.error("Dual sender verification failed:",e.message);
    process.exitCode=2;
  }
}
if(require.main===module)void main();
module.exports={parseArgs,validateDistinctSenders,verifyDualSenderMapping};
