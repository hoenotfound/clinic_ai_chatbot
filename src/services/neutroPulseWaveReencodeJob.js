"use strict";

// One-off, opt-in Neutro Pulse Wave conversion. Disabled everywhere by
// default. Never changes follow-up rules or sends a customer message.
// On success the new immutable object is held for a controlled Meta test.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {spawn} = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");
const {S3Client,HeadObjectCommand,PutObjectCommand} = require("@aws-sdk/client-s3");
const storage = require("./mediaStorageService");
const {probeVideoInfo,isWhatsAppSafeVideoInfo} =
  require("./followUpVideoPreparationService");

const SOURCE = "clients/neutro-sense-tcm/messages/follow-up-config/1794541729931-0368ad99-80b9-4dce-b0ee-fe2cf2097295.mp4";
const DEST = "clients/neutro-sense-tcm/messages/follow-up-config/pulse-wave-h264-aac-full-reencode-v1.mp4";
const LIMIT = 16*1024*1024;
const EXPECTED_SOURCE_BYTES = 5899918;

function enabled(env=process.env){
  return env.NEUTRO_PULSE_REENCODE_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_SENDER_KEY === "neutro_secondary" &&
    storage.getMediaIsolationStatus(env).prefix === "clients/neutro-sense-tcm" &&
    env.R2_BUCKET_NAME === "da-chatbot-neutro-sense-tcm-media";
}
function ffmpegArgs(input,output){
  return [
    "-hide_banner","-loglevel","error","-nostdin","-y",
    "-threads","1","-filter_threads","1",
    "-i",input,"-map","0:v:0","-map","0:a:0?",
    "-map_metadata","-1","-map_chapters","-1",
    "-c:v","libx264","-preset","veryfast",
    "-profile:v","baseline","-level:v","3.1",
    "-pix_fmt","yuv420p","-crf","23",
    "-maxrate","1500k","-bufsize","3000k",
    "-threads","1","-c:a","aac","-b:a","96k","-ar","44100",
    "-movflags","+faststart","-brand","mp42","-f","mp4",output
  ];
}
function validOriginal(b){
  return Buffer.isBuffer(b) && b.length === EXPECTED_SOURCE_BYTES &&
    b.readUInt32BE(0) === 20 &&
    b.toString("ascii",4,8) === "ftyp" &&
    b.toString("ascii",8,12) === "qt  ";
}
function validateResult(b,info){
  if(!Buffer.isBuffer(b)||b.length<300||b.length>=LIMIT ||
     b.toString("ascii",4,8)!=="ftyp" ||
     !["isom","mp42"].includes(b.toString("ascii",8,12)) ||
     !isWhatsAppSafeVideoInfo(info) || info.audioCodec!=="aac" ||
     !Number.isFinite(info.durationSeconds) ||
     Math.abs(info.durationSeconds-56.6)>5){
    throw Error("Output fails MP4/codec/duration/16MB checks");
  }
  const moov=b.indexOf(Buffer.from("moov"));
  const mdat=b.indexOf(Buffer.from("mdat"));
  if(moov<0 || mdat<0 || moov>=mdat ||
    b.indexOf(Buffer.from("avc1"),moov)<0 ||
    b.indexOf(Buffer.from("mp4a"),moov)<0 ||
    (b.indexOf(Buffer.from("avc1"),moov)>mdat) ||
    (b.indexOf(Buffer.from("mp4a"),moov)>mdat) ||
    b.subarray(moov,mdat).indexOf(Buffer.from("tapt"))>=0){
    throw Error("Output still contains unsafe QuickTime tracks or lacks faststart");
  }
  return crypto.createHash("sha256").update(b).digest("hex");
}
async function transcode(input,output,{spawnFn=spawn,tool=ffmpegPath}={}){
  if(!tool)throw Error("ffmpeg-static is unavailable");
  await new Promise((resolve,reject)=>{
    let child,done=false,stderr="";
    const finish=(err)=>{if(done)return;done=true;clearTimeout(timer);if(err)reject(err);else resolve();};
    const timer=setTimeout(()=>{
      child?.kill("SIGKILL");
      finish(Error("FFmpeg conversion timed out after 8 minutes"));
    },8*60*1000);
    timer.unref?.();
    try{child=spawnFn(tool,ffmpegArgs(input,output),{stdio:["ignore","ignore","pipe"]});}
    catch(err){finish(err);return;}
    child.stderr?.on("data",chunk=>{if(stderr.length<4096)stderr+=chunk.toString("utf8");});
    child.on("error",finish);
    child.on("close",(status,signal)=>{
      if(status===0)finish();
      else finish(Error("FFmpeg failed ("+String(status||signal)+"): "+stderr.slice(-400)));
    });
  });
}
function clientFor(env){
  if(!env.R2_ACCOUNT_ID||!env.R2_ACCESS_KEY_ID||!env.R2_SECRET_ACCESS_KEY)
    throw Error("R2 credentials are missing");
  return new S3Client({
    region:"auto",
    endpoint:"https://"+env.R2_ACCOUNT_ID+".r2.cloudflarestorage.com",
    credentials:{accessKeyId:env.R2_ACCESS_KEY_ID,secretAccessKey:env.R2_SECRET_ACCESS_KEY}
  });
}
async function existingObject(client,env){
  try{
    const h=await client.send(new HeadObjectCommand({Bucket:env.R2_BUCKET_NAME,Key:DEST}));
    if(Number(h.ContentLength)<300 ||
       h.Metadata?.reencoded!=="full-ffmpeg-h264-aac-v1" ||
       !/^[a-f0-9]{64}$/.test(String(h.Metadata?.sha256||"")))
       throw Error("R2 destination already exists but does not match expected output");
    return {key:DEST,bytes:Number(h.ContentLength),sha256:h.Metadata.sha256,existing:true};
  }catch(err){
    const status=err?.$metadata?.httpStatusCode;
    if(status===404 || err.name==="NotFound" || err.name==="NoSuchKey")return null;
    throw err;
  }
}
async function probeMetaUpload(bytes,env,fetchFn=fetch){
  if(env.NEUTRO_PULSE_PROBE_META_UPLOAD_ENABLED!=="true")
    return {status:"not_requested"};
  if(!/^\d{10,20}$/.test(String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID||"")) ||
     !String(env.WHATSAPP_SECONDARY_TOKEN||"").trim())
    return {status:"missing_secondary_credentials"};
  const form=new FormData();
  form.append("messaging_product","whatsapp");
  form.append("file",new Blob([bytes],{type:"video/mp4"}),"pulse-wave-reencoded.mp4");
  try{
    const response=await fetchFn(
      "https://graph.facebook.com/v26.0/"+env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID+"/media",
      {method:"POST",headers:{Authorization:"Bearer "+env.WHATSAPP_SECONDARY_TOKEN},
       body:form,signal:AbortSignal.timeout(45000)}
    );
    const result=await response.json();
    return response.ok && typeof result.id==="string" && result.id.length>0
      ? {status:"media_upload_accepted"}
      : {status:"media_upload_rejected",httpStatus:response.status,
         metaCode:Number(result.error?.code)||null};
  }catch(err){
    return {status:"media_upload_not_confirmed",errorCode:String(err?.code||err?.name||"unknown").slice(0,60)};
  }
}
async function run({env=process.env,probe=probeVideoInfo,fetchFn=fetch}={}){
  if(!enabled(env))return {status:"disabled"};
  const client=clientFor(env);
  try{
    const existing=await existingObject(client,env);
    if(existing)return {status:"already_encoded",...existing};
    const source=await storage.downloadMedia(SOURCE,{timeoutMs:40000,maxBytes:LIMIT});
    if(!validOriginal(source))throw Error("Original Neutro Pulse Wave object changed");
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"pulse-wave-ffmpeg-"));
    try{
      const original=path.join(dir,"input.mov");
      const target=path.join(dir,"output.mp4");
      await fs.writeFile(original,source,{mode:0o600,flag:"wx"});
      await transcode(original,target);
      const bytes=await fs.readFile(target);
      const info=await probe(target);
      const digest=validateResult(bytes,info);
      await client.send(new PutObjectCommand({
        Bucket:env.R2_BUCKET_NAME,Key:DEST,Body:bytes,
        ContentType:"video/mp4",Metadata:{
          reencoded:"full-ffmpeg-h264-aac-v1",sha256:digest,
          originalsha256:crypto.createHash("sha256").update(source).digest("hex"),
        }
      }));
      const stored=await existingObject(client,env);
      if(stored?.bytes!==bytes.length||stored?.sha256!==digest)
        throw Error("R2 output could not be verified after upload");
      const uploadProbe=await probeMetaUpload(bytes,env,fetchFn);
      return {status:"encoded",key:DEST,bytes:bytes.length,
        sha256:digest,durationSeconds:info.durationSeconds,
        videoCodec:info.videoCodec,audioCodec:info.audioCodec,
        meta:uploadProbe};
    }finally{
      await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
    }
  }finally{client.destroy();}
}
module.exports={SOURCE,DEST,LIMIT,enabled,ffmpegArgs,validOriginal,
  validateResult,transcode,probeMetaUpload,run};
