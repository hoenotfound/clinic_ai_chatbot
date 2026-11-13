"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {imageReview}=require("../src/utils/standalonePricingManualMedia");

const anchor="2026-11-13T08:00:00Z";
const caption="骨盆调理体验套餐 Package A 体验价 RM388，原价 RM488，内容包括一对一体态评估以及专业顾问说明骨盆调理护理流程，现场会先了解您的情况，再安排适合的体验时间和护理项目。";
const offer={serviceName:"骨盆调理",packageName:"Package A",caption,
  identities:["/promo-images/40"],imageUrl:"/promo-images/40"};
const confirmed=(overrides={})=>({
  created_at:"2026-11-13T10:00:00Z",
  media_url:"https://example.test/staff/other-name.jpg",
  media_mime_type:"image/jpeg",sent_by_username:"WhatsApp Business App",
  content:caption,delivery_status:"delivered",
  whatsapp_message_id:"wamid.test-image-1",
  ...overrides,
});
test("confirmed manual image with same distinctive caption prevents a duplicate despite new URL",()=>{
 assert.deepEqual(imageReview([offer],[confirmed()],{inboundAt:anchor}),{
   action:"already_sent_manually",reason:"manual_pricing_confirmed"});
});
test("an unknown manual delivery never counts as confirmed pricing",()=>{
 assert.equal(imageReview([offer],[confirmed({delivery_status:"unknown"})],{inboundAt:anchor}).action,"review");
});
test("a captionless recent manually reuploaded image is reviewed, not automatically resent",()=>{
 const result=imageReview([offer],[confirmed({content:""})],{inboundAt:anchor});
 assert.deepEqual(result,{action:"review",reason:"manual_image_identity_unverified"});
});
test("a one-price caption under a different image key is held for staff verification",()=>{
 const result=imageReview([offer],[confirmed({content:"骨盆调理 Promo RM388"})],{inboundAt:anchor});
 assert.equal(result.action,"review");
});
test("unrelated staff media and old captionless photos do not suppress new pricing",()=>{
 assert.equal(imageReview([offer],[confirmed({content:"Our shop entrance is next to the parking area"})],{inboundAt:anchor}).action,"clear");
 assert.equal(imageReview([offer],[confirmed({
   created_at:"2026-11-10T00:00:00Z",content:""
 })],{inboundAt:anchor}).action,"clear");
});
test("known configured media URL and failed manual images are not spuriously escalated",()=>{
 assert.equal(imageReview([offer],[confirmed({media_url:"https://clinic.test/promo-images/40"})],{inboundAt:anchor}).action,"clear");
 assert.equal(imageReview([offer],[confirmed({delivery_status:"failed"})],{inboundAt:anchor}).action,"clear");
});
