"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const {spawn}=require("node:child_process");
const ffmpegPath=require("ffmpeg-static");
const {probeVideoInfo}=require("../src/services/followUpVideoPreparationService");
const job=require("../src/services/neutroPulseWaveReencodeJob");

const env={
  NEUTRO_PULSE_REENCODE_ENABLED:"true",
  CLIENT_SLUG:"neutro-sense-tcm",
  WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
  R2_BUCKET_NAME:"da-chatbot-neutro-sense-tcm-media",
};
test("one-off encoding is disabled unless every Neutro tenant condition matches",async()=>{
 assert.equal(job.enabled(env),true);
 for(const bad of [
   {...env,NEUTRO_PULSE_REENCODE_ENABLED:"false"},
   {...env,CLIENT_SLUG:"other-clinic"},
   {...env,WHATSAPP_SECONDARY_SENDER_KEY:"neutro"},
   {...env,R2_BUCKET_NAME:"another-bucket"},
 ])assert.equal(job.enabled(bad),false);
 assert.deepEqual(await job.run({env:{}}),{status:"disabled"});
 assert.match(job.DEST,/^clients\/neutro-sense-tcm\/messages\/follow-up-config\/[a-z0-9-]+\.mp4$/);
 assert.notEqual(job.SOURCE,job.DEST);
});
test("new video uses a full H264/AAC transcode, never stream copy",()=>{
 const args=job.ffmpegArgs("original.mov","result.mp4").join(" ");
 for(const option of [
  "-c:v libx264","-pix_fmt yuv420p","-profile:v baseline",
  "-c:a aac","-b:a 96k","-movflags +faststart",
  "-brand mp42","-map_metadata -1","-threads 1"])
  assert.ok(args.includes(option),option);
 assert.ok(!args.includes("-c copy"));
});
test("conversion rejects original QuickTime, oversized or malformed output",()=>{
 const source=Buffer.alloc(5899918);
 source.writeUInt32BE(20,0);
 source.write("ftyp",4);source.write("qt  ",8);
 assert.equal(job.validOriginal(source),true);
 source.write("mp42",8);
 assert.equal(job.validOriginal(source),false);
 assert.throws(()=>job.validateResult(Buffer.from("mov"),{
   durationSeconds:56.6,videoCodec:"h264",audioCodec:"aac"
 }),/fails MP4/);
});
test("media-only Meta probe cannot send a customer message",async()=>{
 const calls=[];
 const response=await job.probeMetaUpload(Buffer.from("test"),{
   NEUTRO_PULSE_PROBE_META_UPLOAD_ENABLED:"true",
   WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575",
   WHATSAPP_SECONDARY_TOKEN:"test-token",
 },async(url,init)=>{
   calls.push([url,init.method,init.body.get("messaging_product"),
     init.body.get("file").type]);
   return {ok:true,status:200,json:async()=>({id:"approved-upload-id"})};
 });
 assert.deepEqual(response,{status:"media_upload_accepted"});
 assert.equal(calls[0][0],
   "https://graph.facebook.com/v26.0/1318355951360575/media");
 assert.deepEqual(calls[0].slice(1),["POST","whatsapp","video/mp4"]);
 assert.equal((await job.probeMetaUpload(Buffer.from("x"),{})).status,"not_requested");
});
test("real ffmpeg roundtrip cleans QuickTime movie into fast-start MP4",
 {skip:!ffmpegPath},async()=>{
 const d=await fs.mkdtemp(path.join(os.tmpdir(),"pulse-job-test-"));
 try{
   const source=path.join(d,"short.mov"),out=path.join(d,"short.mp4");
   await new Promise((resolve,reject)=>{
     const p=spawn(ffmpegPath,[
       "-hide_banner","-loglevel","error","-y",
       "-f","lavfi","-i","testsrc2=size=160x288:rate=20",
       "-f","lavfi","-i","sine=frequency=440:sample_rate=44100",
       "-t","1","-c:v","libx264","-pix_fmt","yuv420p",
       "-c:a","aac","-f","mov",source
     ],{stdio:["ignore","ignore","pipe"]});
     let err="";
     p.stderr.on("data",x=>err+=String(x));
     p.on("error",reject);
     p.on("close",n=>n===0?resolve():reject(Error(err.slice(-500))));
   });
   await job.transcode(source,out);
   const b=await fs.readFile(out);
   const info=await probeVideoInfo(out);
   assert.equal(info.videoCodec,"h264");
   assert.equal(info.audioCodec,"aac");
   assert.equal(b.toString("ascii",4,8),"ftyp");
   assert.equal(b.toString("ascii",8,12),"mp42");
   const moov=b.indexOf(Buffer.from("moov"));
   const mdat=b.indexOf(Buffer.from("mdat"));
   assert.ok(moov>0 && moov<mdat);
   assert.equal(b.subarray(moov,mdat).indexOf(Buffer.from("tapt")),-1);
 }finally{await fs.rm(d,{recursive:true,force:true});}
});
