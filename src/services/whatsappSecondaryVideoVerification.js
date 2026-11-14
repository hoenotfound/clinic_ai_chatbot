"use strict";
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const crypto=require("node:crypto");
const {probeVideoInfo,isWhatsAppSafeVideoInfo}=
 require("./followUpVideoPreparationService");

const MAX_BYTES=16*1024*1024;
const VERIFIED_TTL_MS=6*60*60*1000;
const MAX_VERIFIED=64;
// Process-local codec evidence is keyed by the immutable R2 content
// fingerprint, never by recipient or raw object key.
const verified=new Map();
const inFlight=new Map();

// A QuickTime MOV can contain H.264/AAC and even be renamed .mp4,
// but Meta can reject its 'qt  ' file brand with media error 131053.
// Only accept an ISO Base Media / MPEG-4 file brand before invoking ffmpeg.
const ISO_MP4_BRANDS=new Set(["isom","iso2","iso4","iso5","iso6","mp41","mp42","avc1"]);
function validMp4Container(bytes){
 if(!Buffer.isBuffer(bytes) || bytes.length<20 ||
    bytes.toString("ascii",4,8)!=="ftyp")return false;
 const atomSize=bytes.readUInt32BE(0);
 if(atomSize<20 || atomSize>bytes.length || atomSize%4!==0)return false;
 const major=bytes.toString("ascii",8,12);
 return ISO_MP4_BRANDS.has(major);
}
function wasCodecVerified(phoneId,fingerprint,now=Date.now()){
 if(!phoneId || !/^[a-f0-9]{64}$/i.test(String(fingerprint||"")))return false;
 const k=phoneId+":"+fingerprint;
 const expires=verified.get(k);
 if(!expires || expires<=now){verified.delete(k);return false;}
 return true;
}
function markCodecVerified(phoneId,fingerprint,now=Date.now()){
 if(!phoneId || !/^[a-f0-9]{64}$/i.test(String(fingerprint||"")))return;
 const k=phoneId+":"+fingerprint;
 verified.delete(k);
 verified.set(k,now+VERIFIED_TTL_MS);
 while(verified.size>MAX_VERIFIED)verified.delete(verified.keys().next().value);
}
async function inspectMp4Codec(bytes,{probe=probeVideoInfo,fsApi=fs,temporaryRoot=os.tmpdir()}={}){
 if(!validMp4Container(bytes) || bytes.length>MAX_BYTES)
   return{ok:false,code:"sender_followup_video_invalid_mp4"};
 let dir;
 try{
  dir=await fsApi.mkdtemp(path.join(temporaryRoot,"neutro-mp4-"));
  const file=path.join(dir,crypto.randomUUID()+".mp4");
  await fsApi.writeFile(file,bytes,{mode:0o600,flag:"wx"});
  const info=await probe(file);
  if(!isWhatsAppSafeVideoInfo(info) ||
      !Number.isFinite(info?.durationSeconds) || info.durationSeconds<=0)
    return{ok:false,code:"sender_followup_video_codec_unsupported"};
  return{ok:true};
 }catch{
  // No provider request has occurred. Failed probing must fail closed rather
  // than silently skip codec checks (including when ffmpeg is unavailable).
  return{ok:false,code:"sender_followup_video_validation_unavailable"};
 }finally{
  if(dir)await fsApi.rm(dir,{recursive:true,force:true}).catch(()=>{});
 }
}
async function verifyMp4Bytes(bytes,{phoneId,fingerprint,probe,fsApi,temporaryRoot}={}){
 if(wasCodecVerified(phoneId,fingerprint))return{ok:true,alreadyVerified:true};
 const key=phoneId&&fingerprint?phoneId+":"+fingerprint:null;
 if(key&&inFlight.has(key))return inFlight.get(key);
 const work=inspectMp4Codec(bytes,{probe,fsApi,temporaryRoot});
 if(key)inFlight.set(key,work);
 try{
  const outcome=await work;
  if(outcome.ok)markCodecVerified(phoneId,fingerprint);
  return outcome;
 }finally{
  if(key&&inFlight.get(key)===work)inFlight.delete(key);
 }
}
function mediaSpecificDeliveryFailure({errorCode,errorTitle,errorMessage}={}){
 const code=Number(errorCode);
 // Meta media download/upload failures. Other provider failures, such as
 // recipient restrictions, are not evidence that the source video is bad.
 if([131052,131053].includes(code))return true;
 const detail=(String(errorTitle||"")+" "+String(errorMessage||"")).slice(0,600);
 return /\b(media|video|file)(?:[ -]?(?:id|format|codec))?\b[\s\S]{0,90}\b(invalid|expired|unsupported|corrupt|download|upload|format|codec|not found)\b|\b(invalid|expired|unsupported|corrupt|codec)\b[\s\S]{0,90}\b(media|video|file)\b/i.test(detail);
}
module.exports={validMp4Container,inspectMp4Codec,verifyMp4Bytes,
 wasCodecVerified,markCodecVerified,mediaSpecificDeliveryFailure};
