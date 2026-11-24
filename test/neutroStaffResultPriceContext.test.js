"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {resolveStaffResultPriceContext}=require("../src/utils/neutroStaffResultPriceContext");
const {resolveShadowPriceException}=require("../src/utils/shadowPriceException");
const {resolveAiPricingDecision}=require("../src/utils/aiPricingIntentDecision");
const {ensureVerifiedPriceReply}=require("../src/utils/verifiedPriceReply");
const {resolveApprovedPricingAssessment}=require("../src/utils/approvedPricingDecision");
const {resolvePricePromotionForReply}=require("../src/utils/pricePromotionTrigger");
const {withPricingHistoryMetadata}=require("../src/utils/conversationStore");
const config=require("../src/config/clinicConfig");
const now=Date.parse("2026-11-24T03:28:49Z");
const services=[{name:"3D 小颜术"},{name:"9D 逆龄抗衰"},{name:"骨盆调理"}];
const serviceAliases=[{alias:"3D",officialService:"3D 小颜术"},{alias:"3D小颜术",officialService:"3D 小颜术"},{alias:"9D",officialService:"9D 逆龄抗衰"}];
const promotions=[{name:"3D 小颜术 First Trial",linkedService:"3D 小颜术",sendOnPriceQuery:true,validFrom:"2000-01-01",validUntil:"2999-12-31",imageUrl:"https://example.test/3d",caption:"首次体验价 RM388（原价 RM888）",pricing:{currency:"MYR",offer:388,normal:888}}];
function turn(role,content,at,extra={}){
  return {role,content,pricingCreatedAtMs:Date.parse(at),...extra};
}
const user=(content,at)=>turn("user",content,at);
const bot=(content,at)=>turn("assistant",content,at);
const staff=(content,at,extra)=>turn("assistant","[Verified STAFF message] "+content,at,{pricingStaffAuthored:true,...extra});
function history(refer=false){
 const rows=[
  user("3D 小颜术","2026-11-23T15:29:15Z"),
  bot("3D小颜术是徒手做的脸型和轮廓护理，不打针哦 😊 一次大约1小时30分钟，你最在意哪一块呢？","2026-11-23T15:29:22Z"),
  staff("[unsupported sent from WhatsApp Business App]","2026-11-23T15:29:25Z",{pricingBusinessAppPlaceholder:true}),
  staff("🗑️ [Message deleted from WhatsApp Business App]","2026-11-23T15:29:26Z",{pricingBusinessAppPlaceholder:true}),
  staff("这个是我们顾客完成【3D小颜术】后的 Before & After ❣️\n可以参考照片中呈现的脸型轮廓、下颚线和双下巴视觉上的变化。每个人基础状态不同，实际变化会不一样哦～","2026-11-24T03:05:48Z",{pricingDeliveredStaffImage:true}),
  bot("跟你分享一位顾客的 3D 脸部护理心得 😊 每个人情况不一样，你还有想了解护理过程或体验安排的地方吗？","2026-11-24T03:05:56Z"),
  user("多少钱","2026-11-24T03:28:23Z"),
 ];
 if(refer)rows.push(bot("请问你想了解哪一项疗程的价格呢？我可以帮你确认 😊","2026-11-24T03:28:29Z"),user("这个","2026-11-24T03:28:49Z"));
 return rows;
}
const args=(rows)=>({customerText:rows.at(-1).content,conversationHistory:rows,services,serviceAliases,promotions,allowStaffResultPriceContext:true,now});
test("customer #9293: direct price and immediate demonstrative clarify the same selected treatment",async()=>{
 for(const refer of [false,true]){
  const a=args(history(refer));
  const verified=resolveStaffResultPriceContext(a);
  assert.deepEqual(verified,{name:"3D 小颜术",priceText:"多少钱"});
  const shadow=resolveShadowPriceException(a);
  assert.equal(shadow?.source,"customer_staff_result_price");
  assert.equal(shadow?.treatment,"3D 小颜术");
  assert.deepEqual(shadow?.prices.map(x=>x.price),["RM388"]);
  const approval=resolveApprovedPricingAssessment({...a,mode:"shadow",shadowException:shadow});
  assert.equal(approval.reason,"approved");
  const old=config.automatedFollowUp;
  try{
   config.automatedFollowUp={...old,assessmentFirstPricingEnabled:true};
   const selected=await resolvePricePromotionForReply({
     ...a,aiPricingEnabled:true,pricingDecision:approval.decision,treatment:shadow.treatment,
     verifiedServiceFromText:shadow.treatment,verifiedShadowPriceService:shadow.treatment,
     language:"zh",priceQuery:true,textSendSucceeded:true,contactId:9293,
     wasPromoRecentlySent:async()=>false,hasUnconfirmedMediaDelivery:async()=>false,
     now:new Date(now),
   });
   assert.ok(selected,"approved current pricing graphic must remain eligible");
  }finally{config.automatedFollowUp=old;}
 }
});
test("same-service result bridge is not granted by an ad, staff text, missing delivery, different service or ambiguous follow-up",()=>{
 const cases=[
  history().slice(1),
  history().map((t,i)=>i===0?{...t,content:"9D 逆龄抗衰"}:t),
  history().map((t,i)=>i===4?{...t,pricingDeliveredStaffImage:false}:t),
  history().map((t,i)=>i===4?{...t,content:"[Verified STAFF message] 9D 逆龄抗衰 Before & After"}:t),
  history().map((t,i)=>i===4?{...t,content:"[Verified STAFF message] 3D 小颜术 Before & After RM999"}:t),
  history().map((t,i)=>i===3?{...t,pricingBusinessAppPlaceholder:false,content:"[Verified STAFF message] 不要发价格"}:t),
  history().map((t,i)=>i===0?{...t,pricingCreatedAtMs:now-25*3600000}:t),
  history().map((t,i)=>i===0?{...t,pricingCreatedAtMs:null}:t),
  history().map((t,i)=>i===5?{...t,content:"我们还有9D 逆龄抗衰"}:t),
  history().map((t,i)=>i===6?{...t,content:"这个"}:t),
  history().map((t,i)=>i===6?{...t,content:"不要报价"}:t),
  history(true).map((t,i)=>i===7?{...t,content:"你哪天方便预约？"}:t),
 ];
 for(const rows of cases)assert.equal(resolveStaffResultPriceContext(args(rows)),null,JSON.stringify(rows));
 assert.equal(resolveShadowPriceException({...args(history()),allowStaffResultPriceContext:false}),null);
});
test("pricing-only metadata requires actual delivered WhatsApp staff image and verified app placeholder",()=>{
 const row={id:1,role:"assistant",sent_by_username:"admin",created_at:new Date(now),
  delivery_status:"delivered",whatsapp_message_id:"wamid.test",has_media_attachment:true,media_mime_type:"image/png"};
 const turn=withPricingHistoryMetadata({role:"assistant",content:"example"},row);
 assert.equal(turn.pricingDeliveredStaffImage,true);
 assert.equal(Object.keys(turn).includes("pricingDeliveredStaffImage"),false);
 assert.equal(withPricingHistoryMetadata({}, {...row,delivery_status:"unknown"}).pricingDeliveredStaffImage,false);
 assert.equal(withPricingHistoryMetadata({}, {...row,whatsapp_message_id:null}).pricingDeliveredStaffImage,false);
 assert.equal(withPricingHistoryMetadata({}, {...row,sent_by_username:null}).pricingDeliveredStaffImage,false);
 const placeholder={...row,sent_by_username:"WhatsApp Business App",content:"[unsupported sent from WhatsApp Business App]",has_media_attachment:false,delivery_status:null,media_mime_type:null};
 assert.equal(withPricingHistoryMetadata({},placeholder).pricingBusinessAppPlaceholder,true);
 assert.equal(withPricingHistoryMetadata({}, {...placeholder,sent_by_username:"admin"}).pricingBusinessAppPlaceholder,false);
 assert.equal(withPricingHistoryMetadata({}, {...placeholder,whatsapp_message_id:null}).pricingBusinessAppPlaceholder,false);
 assert.equal(withPricingHistoryMetadata({}, {...placeholder,whatsapp_customer_mutation:"revoke"}).pricingBusinessAppPlaceholder,false);
});

test("natural customer selections and Malay/English price questions retain the same service, never a guessed model treatment", async()=>{
 const configuredServices=[...services,{name:"1对1体态评估"},{name:"徒手体态调理"},{name:"3D + 9D 组合"},{name:"子宫调理"},{name:"产后调理"},{name:"脉冲波调理"}];
 const aliases=[...serviceAliases,
  {alias:"骨盆调整",officialService:"骨盆调理"},{alias:"骨盆",officialService:"骨盆调理"},
  {alias:"Pelvic Care",officialService:"骨盆调理"},{alias:"Pelvic Treatment",officialService:"骨盆调理"},
  {alias:"9D紧致",officialService:"9D 逆龄抗衰"},{alias:"Firm & Lift",officialService:"9D 逆龄抗衰"},
  {alias:"小颜术",officialService:"3D 小颜术"},{alias:"3D小脸",officialService:"3D 小颜术"},
  {alias:"产后",officialService:"产后调理"},{alias:"子宫",officialService:"子宫调理"},
  {alias:"3D+9D",officialService:"3D + 9D 组合"}];
 // Production-shaped Neutro offers, preserving the actual configured
 // package names, structured price amounts and voucher-caption convention.
 const fixturePromos=[...promotions,
  {name:"9D 逆龄抗衰 First Trial",linkedService:"9D 逆龄抗衰",sendOnPriceQuery:true,validFrom:"2000-01-01",validUntil:"2999-12-31",imageUrl:"https://example.test/9d",pricing:{currency:"MYR",offer:488,normal:1288},caption:"First Trial RM488（原价 RM1288）"},
  {name:"骨盆调理套餐",linkedService:"骨盆调理",sendOnPriceQuery:true,validFrom:"2000-01-01",validUntil:"2999-12-31",packages:[
   {name:"Package A",imageUrl:"https://example.test/pelvic-a",pricing:{currency:"MYR",offer:388,normal:488},caption:"本月限时优惠 🔥\nRM100 优惠券\n原价优惠 RM488\n优惠后仅需\n RM3️⃣8️⃣8️⃣"},
   {name:"Package B",imageUrl:"https://example.test/pelvic-b",pricing:{currency:"MYR",offer:268,normal:368},caption:"本月限时优惠 🔥\nRM100 优惠券\n原价 RM368\n现在只需 RM2️⃣6️⃣8️⃣"}
  ]}];
 const cases=[
  ["我想了解3D","3D 小颜术","多少钱",null,null,["RM388"],"zh"],
  ["I want to know about 3D","3D 小颜术","How much?","Which treatment's price would you like to know?","This one",["RM388"],"en"],
  ["想做骨盆调整","骨盆调理","这个多少钱？",null,null,["RM388","RM268"],"zh"],
  ["Saya berminat dengan Pelvic Care","骨盆调理","Berapa harga?","Harga rawatan mana yang anda ingin tahu?","Yang ini",["RM388","RM268"],"ms"],
  ["I am interested in 9D","9D 逆龄抗衰","How much?",null,null,["RM488"],"en"],
  ["我想了解9D紧致","9D 逆龄抗衰","价钱？",null,null,["RM488"],"zh"],
 ];
 for(const [selection,name,price,question,reference,expected,language] of cases){
   const rows=[
     user(selection,"2026-11-24T03:00:00Z"),
     bot(name+" 是本店提供的护理。","2026-11-24T03:00:01Z"),
     staff(name+" Before & After","2026-11-24T03:05:48Z",{pricingDeliveredStaffImage:true}),
     user(price,"2026-11-24T03:28:23Z"),
   ];
   if(reference)rows.push(bot(question,"2026-11-24T03:28:29Z"),user(reference,"2026-11-24T03:28:49Z"));
   const a={...args(rows),services:configuredServices,serviceAliases:aliases,promotions:fixturePromos};
   const proof=resolveStaffResultPriceContext(a);
   assert.equal(proof?.name,name,selection+" "+price);
   for(const mode of ["shadow","enabled"]){
     const decision=mode==="shadow"?resolveShadowPriceException(a):resolveAiPricingDecision({...a,priceQuery:false,treatment:"徒手体态调理"});
     assert.equal(decision?.source,"customer_staff_result_price",mode+" "+selection);
     assert.deepEqual(decision.prices.map(x=>x.price),expected);
     const approval=resolveApprovedPricingAssessment({...a,mode,shadowException:decision,aiDecision:decision});
     assert.equal(approval.reason,"approved");
     const text=ensureVerifiedPriceReply({...a,reply:"Would you like an assessment?",treatment:name,clarifiedPriceService:name,verifiedShadowPriceService:name,pricingDecision:approval.decision,priceOnlyResponse:true,priceRequested:true,language});
     for(const amount of expected)assert.ok(text.reply.includes(amount),mode+" "+amount+" "+text.reply);
     const graphic=await resolvePricePromotionForReply({
        ...a,aiPricingEnabled:true,pricingDecision:approval.decision,treatment:name,
        verifiedServiceFromText:name,verifiedShadowPriceService:name,language,
        priceQuery:false,textSendSucceeded:true,contactId:9293,
        wasPromoRecentlySent:async()=>false,hasUnconfirmedMediaDelivery:async()=>false,now:new Date(now),
     });
     assert.equal(graphic?.packages?.length,expected.length);
     assert.equal(resolveApprovedPricingAssessment({...a,mode,shadowException:decision,aiDecision:decision,flagged:true}).decision,null);
     assert.equal(resolveApprovedPricingAssessment({...a,mode,shadowException:decision,aiDecision:decision,bookingReady:true}).decision,null);
     assert.equal(resolveApprovedPricingAssessment({...a,mode,shadowException:decision,aiDecision:decision,marketingStopQuestion:true}).decision,null);
     assert.equal(resolveApprovedPricingAssessment({...a,mode,shadowException:decision,aiDecision:decision,promotions:[]}).decision,null);
     const blocked=await resolvePricePromotionForReply({
       ...a,aiPricingEnabled:true,pricingDecision:approval.decision,treatment:name,
       verifiedServiceFromText:name,verifiedShadowPriceService:name,language,
       textSendSucceeded:true,needsAttention:true,contactId:9293,
       wasPromoRecentlySent:async()=>false,hasUnconfirmedMediaDelivery:async()=>false,now:new Date(now),
     });
     assert.equal(blocked,null);
   }
 }
});
test("an ambiguous clarification or unknown Business App activity cannot authorize a quote",()=>{
 const base=history(true);
 for(const text of [
  "请问你想了解哪一项疗程的价格呢？3D 小颜术还是9D 逆龄抗衰？",
  "请问你想了解哪一项疗程的价格呢？Package A 或 Package B？",
  "请问你想了解哪一项疗程的价格呢？3D 小颜术？",
  "请问你想了解哪一项疗程的价格呢？还有其他项目。",
  "Which treatment's price would you like to know? 3D or 9D?",
 ]){
   const rows=base.map((t,i)=>i===7?{...t,content:text}:t);
   assert.equal(resolveStaffResultPriceContext(args(rows)),null,text);
 }
 for(const rows of [
  history().filter((_,i)=>i!==2),
  history().filter((_,i)=>i!==3),
  history().map((t,i)=>i===3?{...t,pricingCreatedAtMs:Date.parse("2026-11-23T15:30:26Z")}:t),
  history().map((t,i)=>i===3?{...t,content:"[Verified STAFF message] [unsupported sent from WhatsApp Business App]"}:t),
  history().map((t,i)=>i===2?{...t,pricingBusinessAppPlaceholder:false}:t),
  history().map((t,i)=>i===5?{...t,content:"请问你想了解 Package A 或 Package B？"}:t),
  history().map((t,i)=>i===0?{...t,content:"3D 小颜术和9D 逆龄抗衰"}:t),
 ]){
  const a=args(rows);
  assert.equal(resolveStaffResultPriceContext(a),null);
  const forged={type:"price",source:"customer_staff_result_price",treatment:"3D 小颜术",clarifiedPriceService:"3D 小颜术",prices:[{name:"3D 小颜术 First Trial",price:"RM388"}]};
  assert.equal(resolveApprovedPricingAssessment({...a,mode:"shadow",shadowException:forged}).decision,null);
 }
});
