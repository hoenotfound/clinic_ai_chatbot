"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { guardFutureOfferIntroductionReply: check, hasCommercialReplyContent: commercial } =
  require("../src/utils/initialOfferReplyGuard");
const { resolveResultMediaForReply } = require("../src/utils/resultMediaTrigger");

const initial = "Hi～我想了解 Neutro Sense TCM 的骨盆调理。之后可以 WhatsApp 跟进我，有相关优惠也可以通知我 😊";
const services = [{name:"骨盆调理",duration:"约30–40分钟"}];
const checkReply = (customerText, reply, options={}) => check({
  channel:"whatsapp",isFirstMessage:true,customerText,reply,
  flagged:false,language:"zh",services,...options,
});

test("unasked model prices and promotional offer text are replaced before Meta send",()=>{
  const messages = [
    "骨盆调理 RM388，另有RM288套餐。",
    "Only RM3️⃣8️⃣8️⃣ this month!",
    "Free 1-hour massage and first-trial special offer.",
    "骨盆调理套餐A和套餐B可以选哦。",
    "现在五折优惠，只需388令吉。",
    "欢迎了解～赠送免费1小时全身按摩",
  ];
  for(const msg of messages){
    const result=checkReply(initial,msg);
    assert.equal(result.replaced,true,msg);
    assert.match(result.reply,/骨盆调理/);
    assert.equal(commercial(result.reply),false,result.reply);
  }
});
test("safe useful treatment answers are preserved",()=>{
  const reply="骨盆调理主要是徒手体态护理 😊 你比较在意小腹还是久坐腰髋紧呢？";
  assert.deepEqual(checkReply(initial,reply),{reply,replaced:false});
});
test("ordinary 'feel free to ask' support is not confused with a free promotional gift",()=>{
  const message = "Feel free to tell us what you'd like to know about 骨盆调理 😊";
  assert.equal(commercial(message),false);
  assert.deepEqual(checkReply(initial,message),{reply:message,replaced:false});
  assert.equal(commercial("Free 1-hour full body massage"),true);
});

test("configured intro is included in final reply review, after assembly and before send",()=>{
  const contaminated="Hi 欢迎来到 Neutro Sense，目前优惠 RM388\n\n骨盆调理主要是徒手体态护理。";
  const result=checkReply(initial,contaminated);
  assert.equal(result.replaced,true);
  assert.equal(commercial(result.reply),false);
  const source=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  const guard=source.indexOf("const guardedOfferIntro = guardFutureOfferIntroductionReply(");
  const send=source.indexOf("const sendOutcome = await sendTrackedText(",guard);
  assert.ok(guard>0 && send>guard);
});
test("actual current price requests are never censored",()=>{
  for(const customerText of [
    initial+"。现在骨盆多少钱？",
    initial+"。骨盆套餐有哪些？",
    initial+"。有优惠现在发给我看看。",
  ]){
    const reply="骨盆套餐是 RM388 和 RM288。";
    assert.deepEqual(checkReply(customerText,reply),{reply,replaced:false},customerText);
  }
});
test("all first WhatsApp turns without a current price request are guarded, including consent refusals",()=>{
  const reply="骨盆 RM388";
  for(const overrides of [
    {isFirstMessage:false},{channel:"facebook"},{channel:"instagram"},{flagged:true},
  ]) assert.deepEqual(checkReply(initial,reply,overrides),{reply,replaced:false});
  // Missing/declined marketing consent must NEVER create an exemption from
  // the customer's no-unrequested-prices rule on their first WhatsApp turn.
  for(const customerText of [
    "我想了解骨盆调理",
    "Hi Neutro Sense TCM，我不希望接收 WhatsApp 优惠，只是想了解骨盆调理。",
  ]) {
    const guarded=checkReply(customerText,reply);
    assert.equal(guarded.replaced,true,customerText);
    assert.equal(commercial(guarded.reply),false);
  }
});
test("safe configured duration is retained if customer asked how long",()=>{
  const text=initial+"。骨盆调理护理需要多久？";
  const result=checkReply(text,"这个月优惠价 RM388");
  assert.equal(result.replaced,true);
  assert.match(result.reply,/30–40分钟/);
  assert.equal(commercial(result.reply),false);
  const poisoned=checkReply(text,"RM388",{services:[{name:"骨盆调理",duration:"RM388 包按摩"}]});
  assert.equal(poisoned.replaced,true);
  assert.equal(commercial(poisoned.reply),false);
});
test("English and Malay fallbacks remain natural and price-free",()=>{
  const samples=[
    ["Hi Neutro Sense TCM. I'm interested in pelvic treatment. I'd also like to receive WhatsApp follow-ups and offers.","en",/^Hi!/],
    ["Hi Neutro Sense TCM. Saya berminat rawatan pelvis. Boleh WhatsApp saya untuk susulan dan promosi berkaitan.","ms",/^Hai!/],
  ];
  for(const [customerText,language,expected] of samples){
    const result=checkReply(customerText,"First Trial package RM388",{language});
    assert.equal(result.replaced,true,customerText);
    assert.match(result.reply,expected);
    assert.equal(commercial(result.reply),false);
  }
});
test("guard leaves configured two pelvic result images eligible",async()=>{
  const fixed=checkReply(initial,"本月套餐优惠 RM388");
  assert.equal(fixed.replaced,true);
  const media=[{service:"骨盆调理",enabled:true,triggerMode:"service_enquiry",
    autoSendCount:2,items:[
      {imageUrl:"/api/config/result-media/image/11",caption:"Before/After 1"},
      {imageUrl:"/api/config/result-media/image/12",caption:"Before/After 2"},
    ]}];
  const photos=await resolveResultMediaForReply({
    customerText:initial,treatment:null,serviceQuery:false,serviceQuerySource:null,
    priceQuery:true,packageQuery:true,flagged:false,bookingReady:false,
    keywordReason:null,needsAttention:false,textSendSucceeded:true,
    resultMedia:media,contactId:383,
    wasMediaRecentlySent:async()=>false,
    hasUnconfirmedMediaDelivery:async()=>false,
    getMostRecentlySentMediaUrl:async()=>null,
  });
  assert.equal(photos?.items?.length,2);
});


test("9D 护理 opt-in fallback identifies the actual configured 9D treatment without pricing", async()=>{
  const serviceList=[
    {name:"骨盆调理",duration:"约30–40分钟"},
    {name:"3D 小颜术",duration:"约1小时30分钟"},
    {name:"9D 逆龄抗衰",duration:"约2小时"},
  ];
  const aliases=[
    {alias:"骨盆",officialService:"骨盆调理"},
    {alias:"3D",officialService:"3D 小颜术"},
    {alias:"9D",officialService:"9D 逆龄抗衰"},
    {alias:"9D抗衰",officialService:"9D 逆龄抗衰"},
  ];
  const text="Hi～想了解 Neutro Sense TCM 9D 护理，之后有配套和优惠可以 WhatsApp 发我 😊";
  const guarded=checkReply(text,"9D 优惠 RM488，送免费按摩",{
    services:serviceList,serviceAliases:aliases,
  });
  assert.equal(guarded.replaced,true);
  assert.match(guarded.reply,/欢迎了解9D 逆龄抗衰/);
  assert.doesNotMatch(guarded.reply,/哪一种护理/);
  assert.equal(commercial(guarded.reply),false);

  // Correcting a first-message text fallback must not alter automatic photo
  // routing, which separately selects the configured 9D result example.
  const images=await resolveResultMediaForReply({
    customerText:text,treatment:"9D 逆龄抗衰",
    serviceQuery:true,serviceQuerySource:"customer_message",
    priceQuery:false,packageQuery:false,
    flagged:false,bookingReady:false,keywordReason:null,needsAttention:false,
    textSendSucceeded:true,contactId:384,
    resultMedia:[{service:"9D 逆龄抗衰",enabled:true,
      triggerMode:"service_enquiry",autoSendCount:1,
      items:[{imageUrl:"/api/config/result-media/image/14",caption:"9D Before & After"}],
    }],
    serviceAliases:aliases,services:serviceList,
    wasMediaRecentlySent:async()=>false,
    hasUnconfirmedMediaDelivery:async()=>false,
    getMostRecentlySentMediaUrl:async()=>null,
  });
  assert.deepEqual(images?.items?.map(item=>item.imageUrl),[
    "/api/config/result-media/image/14",
  ]);
});

test("configured alias fallback preserves 3D and pelvic treatment without guessing",()=>{
  const services=[
    {name:"骨盆调理",duration:"约30–40分钟"},
    {name:"3D 小颜术",duration:"约1小时30分钟"},
    {name:"9D 逆龄抗衰",duration:"约2小时"},
    {name:"3D + 9D 组合",duration:""},
  ];
  const serviceAliases=[
    {alias:"骨盆",officialService:"骨盆调理"},
    {alias:"3D",officialService:"3D 小颜术"},
    {alias:"9D",officialService:"9D 逆龄抗衰"},
    {alias:"3D+9D",officialService:"3D + 9D 组合"},
  ];
  const scenarios=[
    ["骨盆调理","骨盆调理"],
    ["3D 小颜术","3D 小颜术"],
    ["9D 护理","9D 逆龄抗衰"],
    ["3D + 9D 组合","3D + 9D 组合"],
    ["19D 设备",null],
    ["3D、9D",null],
    ["3D 小颜术与9D 护理",null],
    ["想了解护理",null],
  ];
  for(const [topic,expected] of scenarios){
    const text="Hi～想了解 Neutro Sense TCM "+topic+
      "，之后有相关优惠可以 WhatsApp 通知我 😊";
    const guarded=checkReply(text,"9D Promo RM488",{services,serviceAliases});
    assert.equal(guarded.replaced,true,topic);
    assert.equal(commercial(guarded.reply),false,topic);
    if(expected){
      assert.ok(guarded.reply.includes("欢迎了解"+expected),topic);
    }else{
      assert.match(guarded.reply,/你目前最想了解哪一种护理/,topic);
    }
  }

  const priceQuestion="Hi～想了解 Neutro Sense TCM 9D 护理，之后有优惠可以 WhatsApp 通知我。9D现在多少钱？";
  const priced="9D First Trial RM488";
  assert.deepEqual(checkReply(priceQuestion,priced,{services,serviceAliases}),
    {reply:priced,replaced:false});
});

test("9D alias fallback also respects English and Malay service enquiries",()=>{
  const services=[{name:"9D 逆龄抗衰",duration:"约2小时"}];
  const serviceAliases=[{alias:"9D",officialService:"9D 逆龄抗衰"}];
  for(const [text,language,prefix] of [
    ["Hi! I'm interested in Neutro Sense TCM 9D treatment. Feel free to WhatsApp me with follow-ups and related offers.","en",/Hi! Happy to share more about 9D 逆龄抗衰/],
    ["Hi! Saya nak tahu tentang rawatan 9D Neutro Sense TCM. Boleh WhatsApp saya untuk susulan dan promosi berkaitan.","ms",/Hai! Boleh saya terangkan lebih lanjut tentang 9D 逆龄抗衰/],
  ]){
    const reply=checkReply(text,"Special 9D price RM488",{
      services,serviceAliases,language,
    });
    assert.equal(reply.replaced,true,text);
    assert.match(reply.reply,prefix);
    assert.equal(commercial(reply.reply),false);
  }
  // This must be wired at the actual outbound boundary, not just available
  // through the standalone helper.
  const source=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  assert.match(source,/guardFutureOfferIntroductionReply\(\{[\s\S]*?serviceAliases: clinicConfig\.serviceAliases/);
});


test("combination aliases require a literal combination and no separate service",()=>{
  const services=[
    {name:"骨盆调理",duration:"约30–40分钟"},
    {name:"3D 小颜术",duration:"约1小时30分钟"},
    {name:"9D 逆龄抗衰",duration:"约2小时"},
    {name:"3D + 9D 组合",duration:""},
  ];
  const serviceAliases=[
    {alias:"骨盆",officialService:"骨盆调理"},
    {alias:"3D",officialService:"3D 小颜术"},
    {alias:"9D",officialService:"9D 逆龄抗衰"},
    {alias:"3D+9D",officialService:"3D + 9D 组合"},
    {alias:"9D+3D",officialService:"3D + 9D 组合"},
  ];
  const cases=[
    ["3D + 9D 组合","3D + 9D 组合"],
    ["3D+9D","3D + 9D 组合"],
    ["9D+3D","3D + 9D 组合"],
    ["3D、9D",null],
    ["3D 和 9D",null],
    ["3D+9D 还有骨盆",null],
    ["3D + 9D 组合，还有骨盆调理",null],
    ["3D 小颜术，不要 9D","3D 小颜术"],
    ["9D 护理没兴趣",null],
    ["19D 设备",null],
  ];
  for(const [topic,wanted] of cases){
    const text="Hi～想了解 Neutro Sense TCM "+topic+"，有优惠 WhatsApp 通知我 😊";
    const result=checkReply(text,"促销 RM488",{services,serviceAliases});
    assert.equal(result.replaced,true,topic);
    assert.equal(commercial(result.reply),false,topic);
    if(wanted){
      assert.ok(result.reply.includes("欢迎了解"+wanted),topic);
    }else{
      assert.match(result.reply,/你目前最想了解哪一种护理/,topic);
    }
  }
});

test("declining a different service does not permit AI unsolicited commercial text",()=>{
  const services=[{name:"3D 小颜术"},{name:"9D 逆龄抗衰"}];
  const serviceAliases=[
    {alias:"3D",officialService:"3D 小颜术"},
    {alias:"9D",officialService:"9D 逆龄抗衰"},
  ];
  const customerText="Hi～我想了解 Neutro Sense TCM 3D 小颜术，不要 9D，有优惠 WhatsApp 通知我 😊";
  const out=checkReply(customerText,"3D RM488，送免费按摩",{services,serviceAliases});
  assert.equal(out.replaced,true);
  assert.match(out.reply,/欢迎了解3D 小颜术/);
  assert.equal(commercial(out.reply),false);
  // Even an explicit refusal to receive marketing should not expose a price
  // that the person did not request.
  const refusing="Hi Neutro Sense TCM，我不希望接收 WhatsApp 优惠，只是想了解骨盆调理。";
  const reply=checkReply(refusing,"本月 RM388 优惠",{services:[{name:"骨盆调理"}]});
  assert.equal(reply.replaced,true);
  assert.equal(commercial(reply.reply),false);

  // First-contact price questions still pass through untouched.
  const requested=checkReply(
    "Hi～我不想做9D，请问3D 小颜术现在多少钱？",
    "3D 体验价 RM488", {services,serviceAliases}
  );
  assert.deepEqual(requested,{reply:"3D 体验价 RM488",replaced:false});
});

test("first WhatsApp replies retain ordinary numeric clinic details", () => {
  for (const text of [
    "我们的联络号码是 017-483 1336 😊",
    "地址在 PJ C-12-6, Dataran 3 Two Business Centre。",
    "我们的营业时间是星期二至星期五 10am 至 8pm。",
    "For appointments call 012-649 9718.",
  ]) {
    assert.equal(commercial(text), false, text);
    assert.deepEqual(checkReply("请问你们的电话号码或地址？", text), {
      reply: text, replaced: false,
    });
  }
  const unsolicited = checkReply("我想了解骨盆配套", "骨盆配套体验价 RM388");
  assert.equal(unsolicited.replaced, true);
  assert.equal(commercial(unsolicited.reply), false);
});

test("actual first-turn guard catches bare treatment prices without rewriting ordinary package explanations", () => {
  const greeting = "我想了解骨盆配套";
  for (const reply of [
    "骨盆调理 388 / 288",
    "骨盆调理 388，套餐 B 288",
    "388",
    "骨盆护理这次只要 388",
    "Pelvic treatment 388 / 288",
  ]) {
    const result = checkReply(greeting, reply);
    assert.equal(result.replaced, true, reply);
    assert.equal(commercial(result.reply), false, reply);
  }
  for (const reply of [
    "骨盆配套主要针对骨盆、腹直肌与体态问题，先由中医师进行评估。",
    "我们可以先介绍骨盆配套的护理方式和适合人群 😊",
    "骨盆调理套餐主要是徒手护理，不是注射。",
    "可以帮你安排体态评估，之后再看哪种骨盆护理适合。",
    "地址在 PJ C-12-6, Dataran 3 Two Business Centre；联络号码 017-483 1336",
    "2026年星期二至星期五营业；护理一般需要30–40分钟。",
  ]) {
    assert.equal(commercial(reply), false, reply);
    assert.deepEqual(checkReply(greeting, reply), { reply, replaced: false }, reply);
  }
});


test("real client case counts stay factual while Chinese bare ringgit amounts are blocked", () => {
  const enquiry = "我想了解骨盆配套";
  for (const reply of [
    "我们已有1000+体态案例，可以先做1对1评估。",
    "骨盆调理相关的1000+体态案例可供中医师参考。",
    "目前超过1500+位客户了解过这个疗程。",
  ]) {
    assert.equal(commercial(reply), false, reply);
    assert.deepEqual(checkReply(enquiry, reply), { reply, replaced: false }, reply);
  }
  for (const reply of ["骨盆调理388令吉", "骨盆护理 288 令吉"]) {
    assert.equal(checkReply(enquiry, reply).replaced, true, reply);
  }
});


test("price-free Package A/B comparison survives first-contact reply guard", () => {
  const initial = "Hi～我想了解骨盆配套。之后 WhatsApp 可以跟进我，有优惠也可以通知我 😊";
  for (const reply of [
    "骨盆套餐A和套餐B主要分别针对不同护理需求，中医师会先评估。",
    "骨盆配套A包含腹直肌，配套B侧重骨盆。",
    "套餐 A 和 套餐 B 均有不同的护理流程，可以先介绍。",
    "Package A and Package B focus on different goals.",
  ]) {
    assert.equal(commercial(reply), false, reply);
    assert.deepEqual(checkReply(initial, reply), { reply, replaced: false }, reply);
  }
  for (const reply of [
    "骨盆套餐A RM388，套餐B RM288",
    "骨盆配套A 388，配套B 288",
    "Package A 388 and Package B 288",
    "骨盆套餐A和套餐B有本月优惠",
  ]) {
    assert.equal(commercial(reply), true, reply);
    const guarded = checkReply(initial, reply);
    assert.equal(guarded.replaced, true, reply);
    assert.equal(commercial(guarded.reply), false, reply);
  }
});
