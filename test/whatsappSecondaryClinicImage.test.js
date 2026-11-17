"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const helper=require("../src/services/whatsappSecondaryClinicImage");
const publicUrl="/promo-images/71";
const privateUrl="/api/config/result-media/image/72";
function repository({purpose="result_media",mime_type="image/png",bytes=Buffer.from("fake-image")}={}){
 let requested=0;
 return{get requested(){return requested},getImage:async id=>{
  requested++;return{purpose,mime_type,data:bytes.toString("base64")};
 }};
}
test("only exact same-origin Settings identifiers qualify as configured clinic images",()=>{
 assert.deepEqual(helper.storedClinicImageRef(publicUrl),{id:71,purpose:"public_config"});
 assert.deepEqual(helper.storedClinicImageRef(privateUrl),{id:72,purpose:"result_media"});
 for(const u of ["https://untrusted.example/api/config/result-media/image/72",
  "/api/config/result-media/image/72?token=oops",
  "../api/config/result-media/image/72",
  "/api/config/result-media/image/0",
  "/api/config/result-media/image/1/other",
  "/api/conversations/995/media","file:///secret","/promo-images/-4"]){
  assert.equal(helper.storedClinicImageRef(u),null,u);
 }
});
test("secondary Graph upload loads only the matching purpose and bytes server-side",async()=>{
 const repo=repository();
 const r=await helper.loadOwnedClinicImage(privateUrl,{repository:repo});
 assert.equal(repo.requested,1);
 assert.equal(r.mimeType,"image/png");
 assert.equal(r.filename,"clinic-result.png");
 assert.deepEqual(r.buffer,Buffer.from("fake-image"));
 const publicRepo=repository({purpose:"public_config",mime_type:"image/jpeg"});
 const r2=await helper.loadOwnedClinicImage(publicUrl,{repository:publicRepo});
 assert.equal(r2.filename,"clinic-promo.jpg");
 assert.equal((await helper.loadOwnedClinicImage(privateUrl,{repository:publicRepo})),null);
});
test("private media never falls back to public image or cross-purpose record",async()=>{
 const repo=repository({purpose:"public_config"});
 assert.equal(await helper.loadOwnedClinicImage(privateUrl,{repository:repo}),null);
 const wrong=repository({purpose:"result_media"});
 assert.equal(await helper.loadOwnedClinicImage(publicUrl,{repository:wrong}),null);
 const badMime=repository({mime_type:"text/html"});
 assert.equal(await helper.loadOwnedClinicImage(privateUrl,{repository:badMime}),null);
 const huge=repository({bytes:Buffer.alloc(helper.MAX_IMAGE_BYTES+1)});
 assert.equal(await helper.loadOwnedClinicImage(privateUrl,{repository:huge}),null);
 const noLookup=repository();
 assert.equal(await helper.loadOwnedClinicImage("https://untrusted.example/x.jpg",{repository:noLookup}),null);
 assert.equal(noLookup.requested,0);
});

test("trusted production promo URLs resolve to owned database image bytes",async()=>{
 const urls=[
  "https://da-chatbot-neutro-sense-tcm.onrender.com/promo-images/30",
  "https://neutrosense.dasmarketingsolution.com/promo-images/37",
 ];
 const repo=repository({purpose:"public_config",mime_type:"image/jpeg"});
 for(const [i,url] of urls.entries()){
  assert.deepEqual(helper.storedClinicImageRef(url),
   {id:i===0?30:37,purpose:"public_config"});
  const image=await helper.loadOwnedClinicImage(url,{repository:repo});
  assert.equal(image.mimeType,"image/jpeg");
  assert.equal(image.filename,"clinic-promo.jpg");
 }
 assert.equal(repo.requested,2);
});
test("full URL recognition is exact-origin, image-only and never exposes private previews",()=>{
 const origin="https://da-chatbot-neutro-sense-tcm.onrender.com";
 for(const url of [
  origin+"/api/config/result-media/image/72",
  origin+"/promo-images/30?token=secret",
  origin+"/promo-images/30#fragment",
  origin+"/promo-images/../30",
  origin+"/promo-images/0",
  origin+"/promo-images/30/other",
  "http://da-chatbot-neutro-sense-tcm.onrender.com/promo-images/30",
  "https://da-chatbot-neutro-sense-tcm.onrender.com.evil.example/promo-images/30",
  "https://da-chatbot-neutro-sense-tcm.onrender.com@evil.example/promo-images/30",
  "https://da-chatbot-neutro-sense-tcm.onrender.com:8443/promo-images/30",
  "https://evil.example/promo-images/30",
 ]){
  assert.equal(helper.storedClinicImageRef(url),null,url);
 }
});
test("configured HTTPS public origin may resolve clinic promos but never private URLs",()=>{
 const previous=process.env.PUBLIC_BASE_URL;
 try{
  process.env.PUBLIC_BASE_URL="https://neutro-custom.example";
  assert.deepEqual(helper.storedClinicImageRef(
   "https://neutro-custom.example/promo-images/30"),{id:30,purpose:"public_config"});
  assert.equal(helper.storedClinicImageRef(
   "https://neutro-custom.example/api/config/result-media/image/72"),null);
  process.env.PUBLIC_BASE_URL="http://neutro-custom.example";
  assert.equal(helper.storedClinicImageRef("https://neutro-custom.example/promo-images/30"),null);
 }finally{
  if(previous===undefined)delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL=previous;
 }
});
