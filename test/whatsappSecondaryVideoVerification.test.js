"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {
 validMp4Container,inspectMp4Codec,verifyMp4Bytes,mediaSpecificDeliveryFailure,
 wasCodecVerified,
}=require("../src/services/whatsappSecondaryVideoVerification");
const mp4=Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from("ftypisom00000000")]);
function files(){
 const calls=[];
 return {calls,fsApi:{
   mkdtemp:async()=>"/tmp/dummy-video-probe",
   writeFile:async(...args)=>{calls.push(["write",...args]);},
   rm:async(...args)=>{calls.push(["remove",...args]);},
 }};
}
test("Meta video preflight rejects QuickTime brands despite H.264/AAC codecs",async()=>{
 const qt=Buffer.from(mp4);
 qt.write("qt  ",8,"ascii");
 qt.write("qt  ",16,"ascii");
 assert.equal(validMp4Container(qt),false);
 assert.equal(validMp4Container(mp4),true);
 const candidate=Buffer.from(mp4);
 candidate.write("mp42",8,"ascii");
 candidate.write("isom",16,"ascii");
 assert.equal(validMp4Container(candidate),true);
 let called=false;
 const rejected=await inspectMp4Codec(qt,{
   fsApi:files().fsApi,probe:async()=>{
     called=true;return {durationSeconds:56.6,videoCodec:"h264",audioCodec:"aac"};
   },
 });
 assert.equal(rejected.code,"sender_followup_video_invalid_mp4");
 assert.equal(called,false,"QuickTime video must never reach codec probe/upload");
});
test("H.264/AAC, no audio, and bad codecs are distinguished without uploading",async()=>{
 const file=files();
 const codec=await inspectMp4Codec(mp4,{fsApi:file.fsApi,
   probe:async()=>({durationSeconds:10,videoCodec:"h264",audioCodec:"aac"})});
 assert.equal(codec.ok,true);
 assert.equal(file.calls.filter(x=>x[0]==="write").length,1);
 assert.equal(file.calls.filter(x=>x[0]==="remove").length,1);
 assert.equal((await inspectMp4Codec(mp4,{fsApi:files().fsApi,
   probe:async()=>({durationSeconds:10,videoCodec:"h264",audioCodec:null})})).ok,true);
 const hevc=await inspectMp4Codec(mp4,{fsApi:files().fsApi,
   probe:async()=>({durationSeconds:10,videoCodec:"hevc",audioCodec:"aac"})});
 assert.equal(hevc.code,"sender_followup_video_codec_unsupported");
 assert.equal((await inspectMp4Codec(Buffer.from("not a video"))).code,
   "sender_followup_video_invalid_mp4");
 const unavailable=await inspectMp4Codec(mp4,{fsApi:files().fsApi,
   probe:async()=>{throw Error("ffmpeg unavailable");}});
 assert.equal(unavailable.code,"sender_followup_video_validation_unavailable");
});
test("verified source cache is bounded to exact phone and content fingerprint",async()=>{
 const fp="1".repeat(64);
 const file=files();
 const first=await verifyMp4Bytes(mp4,{phoneId:"101",fingerprint:fp,fsApi:file.fsApi,
   probe:async()=>({durationSeconds:8,videoCodec:"h264",audioCodec:"aac"})});
 assert.equal(first.ok,true);
 assert.equal(wasCodecVerified("101",fp),true);
 assert.equal(wasCodecVerified("102",fp),false);
 const again=await verifyMp4Bytes(mp4,{phoneId:"101",fingerprint:fp,fsApi:{
   mkdtemp:async()=>{throw Error("should use validated content");}
 }});
 assert.equal(again.alreadyVerified,true);
});
test("only a media-specific confirmed provider failure qualifies for invalidation",()=>{
 assert.equal(mediaSpecificDeliveryFailure({errorCode:"131053"}),true);
 assert.equal(mediaSpecificDeliveryFailure({errorCode:131052}),true);
 assert.equal(mediaSpecificDeliveryFailure({
  errorCode:131000,errorTitle:"Video format unsupported"}),true);
 assert.equal(mediaSpecificDeliveryFailure({errorCode:131047,errorTitle:"Re-engagement blocked"}),false);
 assert.equal(mediaSpecificDeliveryFailure({errorCode:131050,errorTitle:"Invalid recipient"}),false);
});
