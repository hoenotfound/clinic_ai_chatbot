"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {sendSecondaryStaffMedia}=require("../src/services/whatsappSecondaryMediaDispatch");
const contact={
  id:73,channel:"whatsapp",mode:"human",whatsapp_number:"60125550000",
  whatsapp_sender_id:9,whatsapp_sender_key:"ariel",
};
const env={
  WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED:"true",
  WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"true",
  WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
};
const options={staffMedia:true,currentMessageId:123,autoFollowUp:false};
function fake(overrides={}) {
  const events=[], provider={
    async uploadMedia(buf,mime,file){events.push(["upload",buf.length,mime,file]);return{success:true,mediaId:"555001"};},
    async sendMediaById(type,id,opts){events.push(["send",type,id,opts]);return{success:true,wamid:"wamid.ariel-media"};},
    async sendImageByUrl(url,caption){events.push(["url",url,caption]);return{success:true,wamid:"wamid.ariel-url"};},
  };
  const deps={
    env,database:{},
    contacts:{getContactById:async()=>contact},
    storage:{downloadMedia:async()=>Buffer.from("video bytes")},
    policyService:{previewSecondaryFreeformPolicy:async()=>({policyAllowed:true})},
    textDispatcher:async ({messageId,preSendCheck,origin,dispatchTransport})=>{
      events.push(["billing",messageId,origin]);
      if (!await preSendCheck())return{success:false,retryable:false};
      assert.equal(typeof dispatchTransport,"function",
        "real dispatcher must receive media callback in its FIRST argument");
      return dispatchTransport(provider);
    },
    ...overrides,
  };
  return {deps,events};
}
test("secondary staff image uses its own media ID upload after sender billing",async()=>{
  const {deps,events}=fake();
  const result=await sendSecondaryStaffMedia(contact,"sendImageBuffer",[
    Buffer.from("image"),"image/jpeg","Hello","image.jpg",options,
  ],deps);
  assert.equal(result.success,true);
  assert.deepEqual(events.map(x=>x[0]),["billing","upload","send"]);
  assert.equal(events[2][1],"image");
  assert.equal(events[2][2],"555001");
});
test("secondary staff voice sends audio with provider voice flag",async()=>{
  const {deps,events}=fake();
  const result=await sendSecondaryStaffMedia(contact,"sendAudioBuffer",[
    Buffer.from("voice"),"audio/ogg","voice.ogg",options,
  ],deps);
  assert.equal(result.success,true);
  assert.equal(events[2][1],"audio");
  assert.equal(events[2][3].voice,true);
});
test("secondary staff document and video never use primary cached IDs",async()=>{
  for(const [method,args,type] of [
    ["sendDocumentBuffer",[Buffer.from("document"),"application/pdf","report.pdf","caption",options],"document"],
    ["sendVideoByStoredKey",["r2-video-key","Hi","video.mp4",{...options,videoMimeType:"video/mp4"}],"video"],
    ["sendStickerBuffer",[Buffer.from("sticker"),"image/webp","sticker.webp",options],"sticker"],
  ]){
    const {deps,events}=fake();
    assert.equal((await sendSecondaryStaffMedia(contact,method,args,deps)).success,true);
    assert.equal(events[2][1],type);
    assert.deepEqual(events.map(x=>x[0]),["billing","upload","send"]);
  }
});
test("sender media refuses AI, marketing followups, missing saved message, or wrong sender",async()=>{
  for(const [c,method,args,optionsOverride] of [
    [contact,"sendImageBuffer",[Buffer.from("photo"),"image/jpeg","Hi","x.jpg",{...options,staffMedia:false}]],
    [contact,"sendImageBuffer",[Buffer.from("photo"),"image/jpeg","Hi","x.jpg",{...options,autoFollowUp:true}]],
    [contact,"sendImageBuffer",[Buffer.from("photo"),"image/jpeg","Hi","x.jpg",{...options,currentMessageId:null}]],
    [{...contact,whatsapp_sender_key:"neutro"},"sendImageBuffer",[Buffer.from("photo"),"image/jpeg","Hi","x.jpg",options]],
    [contact,"sendImageBuffer",[Buffer.from("photo"),"image/png","Hi","x.jpg",options],{WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED:"false"}],
  ]){
    const {deps,events}=fake();
    if(optionsOverride)deps.env={...env,...optionsOverride};
    const result=await sendSecondaryStaffMedia(c,method,args,deps);
    assert.equal(result.success,false);
    assert.equal(events.length,0);
  }
});
test("sender changed during upload: do not send media under the previous business number",async()=>{
  const {deps,events}=fake({
    contacts:{getContactById:async()=>({...contact,whatsapp_sender_key:"neutro"})},
  });
  const result=await sendSecondaryStaffMedia(contact,"sendImageBuffer",[
    Buffer.from("image"),"image/jpeg","Hi","image.jpg",options,
  ],deps);
  assert.equal(result.success,false);
  assert.equal(events.length,1);
  // Real dispatcher checks preSendCheck before making reservation.
  assert.equal(events[0][0],"billing");
});
test("fake sender token, missing file or unknown methods never dispatch",async()=>{
  for(const [method,args] of [
    ["sendImageBuffer",[Buffer.alloc(0),"image/jpeg","Hi","x.jpg",options]],
    ["sendAudioBuffer",[Buffer.from("mp3"),"text/plain","x.mp3",options]],
    ["sendDocumentBuffer",[Buffer.from("doc"),"application/pdf","../secret","Hi",options]],
    ["sendUnknown",[Buffer.from("item"),"image/png","x",options]],
  ]){
    const {deps,events}=fake();
    const result=await sendSecondaryStaffMedia(contact,method,args,deps);
    assert.equal(result.success,false);
    assert.equal(events.length,0);
  }
});
