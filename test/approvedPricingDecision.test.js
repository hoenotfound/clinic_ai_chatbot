"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveApprovedPricingDecision } = require("../src/utils/approvedPricingDecision");
const { resolveNumberedPricingMenuSelection } = require("../src/utils/numberedPricingMenuSelection");
const { verifiedPricesForService } = require("../src/utils/verifiedPriceReply");
const { guardAssessmentFirstPricingReply } = require("../src/utils/initialOfferReplyGuard");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply, selectPromoDuplicateCheck } = require("../src/utils/pricePromotionTrigger");

const services = [{ name: "骨盆调理" }, { name: "3D 小颜术" }, { name: "9D 逆龄抗衰" }];
const serviceAliases = [
  { alias: "骨盆", officialService: "骨盆调理" },
  { alias: "盆骨调整", officialService: "骨盆调理" },
  { alias: "3D", officialService: "3D 小颜术" },
];
const promotions = [{
  name: "骨盆套餐", linkedService: "骨盆调理", sendOnPriceQuery: true,
  packages: [
    { name: "Package A", imageUrl: "https://example.test/pelvic-a.jpg",
      caption: "本月限时优惠 现在只需 RM388",
      pricing: {currency:"MYR",offer:388,normal:488} },
    { name: "Package B", imageUrl: "https://example.test/pelvic-b.jpg",
      caption: "本月限时优惠 现在只需 RM288",
      pricing: {currency:"MYR",offer:288,normal:388} },
  ],
}, {
  name: "3D First Trial", linkedService: "3D 小颜术", sendOnPriceQuery: true,
  imageUrl: "https://example.test/3d.jpg", caption: "3D First Trial 现在只需 RM488",
  pricing: {currency:"MYR",offer:488,normal:888},
}];
const pelvicDecision = Object.freeze({
  source: "recent_first_customer", type: "price", treatment: "骨盆调理",
  prices: [
    {name:"Package A",price:"RM388",afterVoucher:true},
    {name:"Package B",price:"RM288"},
  ],
});
const threeDDecision = {
  source: "recent_customer", type: "price", treatment: "3D 小颜术",
  prices: [{name:"Main offer",price:"RM488"}],
};
const base = { services, serviceAliases, resultMedia: [] };
const history93 = [
  {role:"user",content:"Hi～我对 Neutro Sense TCM 骨盆调理有兴趣"},
  {role:"assistant",content:"我们的骨盆调理可以先来体验"},
  {role:"assistant",content:"骨盆 Before & After",mediaUrl:"https://example.test/result1.jpg"},
  {role:"assistant",content:"骨盆 Before & After",mediaUrl:"https://example.test/result2.jpg"},
  {role:"user",content:"疗程多少钱"},
];
const history524 = [
  {role:"user",content:"Hi～想了解 Neutro Sense TCM 3D 小颜术"},
  {role:"assistant",content:"3D小颜术可以先做评估"},
  {role:"assistant",content:"3D小颜术 Before & After"},
  {role:"assistant",content:"Hi～3D 小颜术是徒手护理"},
  {role:"user",content:"大概需要做几次呢？价钱呢？"},
];

function approve(overrides={}) {
  return resolveApprovedPricingDecision({
    mode:"shadow", shadowException:pelvicDecision,
    customerText:"疗程多少钱", conversationHistory:history93,
    ...base, ...overrides,
  });
}
function mediaOptions(decision, customerText, conversationHistory, overrides={}) {
  return {
    aiPricingEnabled:Boolean(decision), pricingDecision:decision,
    priceQuery:true,packageQuery:false,
    treatment:decision?.treatment || null,
    verifiedServiceFromText:decision?.treatment || null,
    customerText, conversationHistory, services,serviceAliases,
    resultMedia:[],promotions,language:"zh",contactId:93,
    flagged:false,bookingReady:false,keywordReason:null,
    needsAttention:false,textSendSucceeded:true,
    wasPromoRecentlySent:async()=>false,
    hasUnconfirmedMediaDelivery:async()=>false,
    ...overrides,
  };
}

test("live #93: a verified Shadow exception cannot be undone by another reply guard", async()=>{
  const approved=approve({aiDecision:pelvicDecision});
  assert.ok(Object.isFrozen(approved));
  assert.ok(Object.isFrozen(approved.prices));
  assert.equal(approved?.treatment,"骨盆调理");
  const model="骨盆调理 Package A RM388 和 Package B RM288";
  const guard=guardAssessmentFirstPricingReply({
    customerText:"疗程多少钱",reply:model,treatment:approved.treatment,
    verifiedPricingIntent:Boolean(approved),requireVerifiedTreatment:true,
    conversationHistory:history93,services,serviceAliases,resultMedia:[],
  });
  assert.equal(guard.replaced,false, "the independently verified amount must reach the quote formatter");
  const quoted=ensureVerifiedPriceReply({
    customerText:"疗程多少钱",reply:guard.reply,
    treatment:approved.treatment,pricingDecision:approved,
    priceOnlyResponse:true,conversationHistory:history93,
    services,serviceAliases,promotions,resultMedia:[],language:"zh",
  });
  assert.equal(quoted.restored,true);
  assert.match(quoted.reply,/RM388/u);
  assert.match(quoted.reply,/RM288/u);
  assert.doesNotMatch(quoted.reply,/哪一项疗程/u);
  const media=await resolvePricePromotionForReply(mediaOptions(approved,"疗程多少钱",history93));
  assert.deepEqual(media?.packages.map(p=>p.name),["Package A","Package B"]);
});

test("live #524: verified 3D mixed session/count and price query shares the same authorization",async()=>{
  const approved=approve({
    shadowException:threeDDecision,
    customerText:"大概需要做几次呢？价钱呢？",
    conversationHistory:history524,
  });
  assert.equal(approved?.treatment,"3D 小颜术");
  const priced=ensureVerifiedPriceReply({
    customerText:"大概需要做几次呢？价钱呢？",
    reply:"3D小颜术需要评估后确认次数，价格稍后告诉你",
    treatment:approved.treatment,pricingDecision:approved,
    priceOnlyResponse:true,services,serviceAliases,promotions,
    conversationHistory:history524,language:"zh",
  });
  assert.match(priced.reply,/RM488/u);
  const media=await resolvePricePromotionForReply(mediaOptions(
    approved,"大概需要做几次呢？价钱呢？",history524,{contactId:524}
  ));
  assert.deepEqual(media?.packages.map(p=>p.name),["Main offer"]);
});

test("Off-mode clients retain their existing legacy pricing flow",()=>{
  assert.equal(approve({mode:"off",shadowException:pelvicDecision}),null);
  assert.equal(approve({mode:"off",numberedMenuDecision:{
    ...pelvicDecision,source:"numbered_price_menu"
  }}),null);
});

test("Shadow observation alone NEVER authorizes customer-facing prices or graphics",async()=>{
  const observed=approve({shadowException:null,aiDecision:pelvicDecision});
  assert.equal(observed,null);
  const guard=guardAssessmentFirstPricingReply({
    customerText:"多少钱",reply:"骨盆套餐 RM388",treatment:null,
    verifiedPricingIntent:Boolean(observed),requireVerifiedTreatment:true,
    conversationHistory:[{role:"user",content:"多少钱"}],services,serviceAliases,
  });
  assert.equal(guard.replaced,true);
  assert.doesNotMatch(guard.reply,/RM388/u);
});

test("Enabled authorizes verified price, but not a model-only label or unsupported amount",()=>{
  const allowed=approve({mode:"enabled",aiDecision:pelvicDecision,shadowException:null});
  assert.deepEqual(allowed?.prices.map(x=>x.price),["RM388","RM288"]);
  assert.equal(approve({mode:"enabled",aiDecision:{...pelvicDecision,prices:[{name:"Package A",price:"RM0"}]}}),null);
  assert.equal(approve({mode:"enabled",aiDecision:{...pelvicDecision,prices:[{name:"Package A",price:"RM388"},{name:"Package A",price:"RM388"}]}}),null);
  assert.equal(approve({mode:"enabled",aiDecision:{...pelvicDecision,treatment:"Unknown"} }),null);
  assert.equal(approve({mode:"enabled",aiDecision:null}),null);
});

test("Clinical, booking, marketing STOP and flagged/staff review cannot authorize prices",()=>{
  for(const condition of [{flagged:true},{bookingReady:true},{marketingStopQuestion:true},
    {keywordReason:"staff"},{customerText:"我怀孕了，疗程多少钱"}]) {
    assert.equal(approve(condition),null,JSON.stringify(condition));
  }
});

test("An approved Package B continuation cannot send Package A",async()=>{
  const selected={...pelvicDecision,source:"customer_scoped_packages",
    clarifiedPriceService:"骨盆调理",prices:[{name:"Package B",price:"RM288"}]};
  const approved=approve({scopedPackageDecision:selected,shadowException:null});
  assert.deepEqual(approved?.prices.map(p=>p.name),["Package B"]);
  const media=await resolvePricePromotionForReply(mediaOptions(approved,"骨盆",[
    {role:"user",content:"Package B 多少钱？"},
    {role:"assistant",content:"请问哪个疗程？"},
    {role:"user",content:"骨盆"},
  ]));
  assert.deepEqual(media?.packages.map(p=>p.name),["Package B"]);
});

test("Manually delivered picture with an older caption still suppresses repeat",async()=>{
  const approved=approve();
  let lookedUp=[];
  const messagesRepo={
    wasPromoRecentlySent:async()=>false,
    wasMediaRecentlySent:async(id,url,hours)=>{
      lookedUp.push(url);
      return url.endsWith("pelvic-a.jpg");
    },
  };
  const duplicate=selectPromoDuplicateCheck({
    aiPricingEnabled:Boolean(approved),messagesRepo,
  });
  const media=await resolvePricePromotionForReply(mediaOptions(
    approved,"疗程多少钱",history93,{wasPromoRecentlySent:duplicate}
  ));
  assert.ok(lookedUp.some(url=>url.endsWith("pelvic-a.jpg")));
  assert.deepEqual(media?.packages.map(p=>p.name),["Package B"]);
  const held=await resolvePricePromotionForReply(mediaOptions(
    approved,"疗程多少钱",history93,{hasUnconfirmedMediaDelivery:async()=>true}
  ));
  assert.equal(held,null);
});

test("Server wires one approved decision to guard, quote, media and duplicate lookup",()=>{
  const server=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  assert.match(server,/const approvedPricingDecision = resolveApprovedPricingDecision\(/u);
  assert.match(server,/verifiedPricingIntent: Boolean\(approvedPricingDecision\)/u);
  assert.match(server,/const authorizedPricingInput = pricingAuthorityRequired\s*\? approvedPricingDecision : undefined/u);
  assert.match(server,/pricingDecision: authorizedPricingInput/u);
  assert.match(server,/pricingDecision: pricingAuthorityRequired \? approvedPricingDecision : null/u);
  assert.match(server,/aiPricingEnabled: pricingAuthorityRequired/u);
  assert.doesNotMatch(server,/pricingDecision: approvedPricingDecision \|\| \(aiPricingEnabled/u);
  assert.doesNotMatch(server,/service => service\.name === pricingDecision\?\.treatment/u);
});

test("representative #525/#532 menu formats resolve verified 1 through quote and media", async()=>{
  const now=Date.now();
  const turn=(role,content,secondsBefore=0,staff=false)=>({
    role,content,pricingCreatedAtMs:now-secondsBefore*1000,
    pricingStaffAuthored:staff,
  });
  const examples=[
    {contact:525,price:"什么价钱呢？",
      menu:"我们目前有以下疗程：\n1. 骨盆/体态调理（适合产后、久坐、体态不平衡）\n2. 3D 小颜术（脸型轮廓护理）\n3. 9D 逆龄抗衰（仪器紧致）\n\n你想了解哪一项的价钱呢？"},
    {contact:532,price:"请问一次收费是多少呢",
      menu:"主要有以下疗程：\n1. 骨盆/体态调理：中医师徒手调理\n2. 3D 小颜术：脸型护理\n\n你想先了解哪一项的收费呢？"},
  ];
  for(const example of examples) {
    const history=[
      // Old staff reply before the current continuous session is not reused.
      turn("assistant","[Verified STAFF message] Old chat",30*3600,true),
      turn("user",example.price,90),
      turn("assistant","请问你想了解哪项疗程的价格呢？",75),
      turn("user","有什么疗程呢？",60),
      turn("assistant",example.menu,45),
      turn("user","1",30),
    ];
    const selection=resolveNumberedPricingMenuSelection({
      customerText:"1",conversationHistory:history,services,serviceAliases,now,
    });
    assert.deepEqual(selection,{treatment:"骨盆调理",source:"numbered_price_menu"},
      "real menu parser must select a single trusted pelvic treatment");
    const prices=verifiedPricesForService(selection.treatment,promotions,"1",history,{
      clarifiedPriceService:selection.treatment,
    });
    const approved=resolveApprovedPricingDecision({
      mode:"shadow",numberedMenuDecision:{
        type:"price",treatment:selection.treatment,source:selection.source,
        clarifiedPriceService:selection.treatment,prices,
      },customerText:"1",conversationHistory:history,...base,
    });
    assert.ok(approved);
    assert.deepEqual(approved.prices.map(p=>p.price),["RM388","RM288"]);
    const quote=ensureVerifiedPriceReply({
      customerText:"1",reply:"我帮你确认价格 😊",treatment:approved.treatment,
      pricingDecision:approved,priceOnlyResponse:true,language:"zh",
      conversationHistory:history,services,serviceAliases,promotions,resultMedia:[],
    });
    assert.match(quote.reply,/RM388/u);
    assert.match(quote.reply,/RM288/u);
    const media=await resolvePricePromotionForReply(mediaOptions(
      approved,"1",history,{contactId:example.contact,
        verifiedNumberedSelection:selection.treatment}
    ));
    assert.deepEqual(media?.packages.map(p=>p.name),["Package A","Package B"]);
  }
});

test("bare numbers never inherit ad, staff, expired or ambiguous menus",()=>{
  const now=Date.now();
  const t=(role,content,age=0,staff=false)=>({
    role,content,pricingCreatedAtMs:now-age*1000,pricingStaffAuthored:staff,
  });
  const price=t("user","什么价钱呢？",100);
  const clarify=t("assistant","请问哪个疗程的价格呢？",90);
  const list=t("user","有什么疗程呢？",80);
  const options=t("assistant","1. 骨盆/体态调理（适合产后）\n2. 3D 小颜术（护理）\n你想了解哪项的价钱呢？",70);
  const selected=t("user","1",60);
  const resolve=(history)=>resolveNumberedPricingMenuSelection({
    customerText:"1",conversationHistory:history,services,serviceAliases,now,
  });
  assert.equal(resolve([selected]),null);
  assert.equal(resolve([price,clarify,list,options,{...selected,pricingCreatedAtMs:null}]),null);
  assert.equal(resolve([price,clarify,list,{...options,pricingStaffAuthored:true},selected]),null);
  assert.equal(resolve([price,clarify,list,
    t("assistant","1. 骨盆/3D（混合）\n2. 9D 逆龄抗衰\n你想了解哪项的价钱呢？",70),selected]),null);
  assert.equal(resolve([t("user","免费评估是多少钱",100),clarify,list,options,selected]),null);
  assert.equal(resolve([price,clarify,list,
    t("assistant","1. 骨盆/体态调理（3D 小颜术）\n2. 9D 逆龄抗衰\n你想了解哪项的价钱呢？",70),selected]),null);
  assert.equal(approve({shadowException:null,aiDecision:{...pelvicDecision,source:"meta_ad"},
    customerText:"1"}),null);
});

test("conflicting related-treatment or unpriced primary NEVER inherits pelvic package prices",()=>{
  const related=[{
    enabled:true,service:"骨盆调理",relatedServices:["徒手体态调理"],
  }];
  const extendedServices=[...services,{name:"徒手体态调理",priceRange:""}];
  const extendedAliases=[...serviceAliases,{alias:"整骨",officialService:"徒手体态调理"}];
  for (const source of ["recent_customer","current_customer","continued_customer",
    "numbered_price_menu","customer_scoped_packages","meta_ad"]) {
    const candidate={...pelvicDecision,source};
    assert.equal(resolveApprovedPricingDecision({
      mode:"enabled",aiDecision:candidate,
      customerText:"整骨多少钱？",
      conversationHistory:[{role:"user",content:"整骨多少钱？"}],
      services:extendedServices,serviceAliases:extendedAliases,resultMedia:related,
    }),null,source);
  }
  const legitimate=resolveApprovedPricingDecision({
    mode:"enabled",aiDecision:pelvicDecision,
    customerText:"骨盆调理多少钱？",
    conversationHistory:[{role:"user",content:"骨盆调理多少钱？"}],
    services:extendedServices,serviceAliases:extendedAliases,resultMedia:related,
  });
  assert.equal(legitimate?.treatment,"骨盆调理");
});

test("pricing audit persists stage fields without storing customer message content",async()=>{
  const { recordDecision }=require("../src/db/pricingDecisionAuditRepo");
  let call=null;
  await recordDecision({
    contactId:93,inboundMessageId:1911,mode:"shadow",
    observed:true,approved:true,treatment:"骨盆调理",
    decisionSource:"recent_first_customer",replyStatus:"approved_price_quoted",
    mediaStatus:"skipped",mediaReason:"all_graphics_already_sent",
    mediaPackagesSelected:0,
  },async(sql,params)=>{call={sql,params};});
  assert.match(call.sql,/ON CONFLICT \(inbound_message_id\)/u);
  assert.equal(call.params[0],93);
  assert.equal(call.params[6],"recent_first_customer");
  assert.equal(call.params[9],"all_graphics_already_sent");
  assert.doesNotMatch(call.sql,/customer_message|customer_text|phone_number/u);
  await assert.rejects(()=>recordDecision({
    contactId:93,inboundMessageId:1911,mode:"shadow",
    replyStatus:"quoted",mediaStatus:"skipped",
    mediaPackagesSelected:4,
  },async()=>{throw Error("should not write");}),/Invalid pricing audit stage/u);
});

test("promotional selector returns specific skip-stage reasons, not silent nulls",async()=>{
  const approved=approve();
  const reasons=[];
  const missing=await resolvePricePromotionForReply(mediaOptions(approved,"疗程多少钱",
    history93,{contactId:93,hasUnconfirmedMediaDelivery:async()=>true,
      onSkip:reason=>reasons.push(reason)}));
  assert.equal(missing,null);
  assert.deepEqual(reasons,["unconfirmed_media_delivery"]);
  reasons.length=0;
  const duplicate=await resolvePricePromotionForReply(mediaOptions(approved,"疗程多少钱",
    history93,{contactId:93,wasPromoRecentlySent:async()=>true,
      onSkip:reason=>reasons.push(reason)}));
  assert.equal(duplicate,null);
  assert.deepEqual(reasons,["all_graphics_already_sent"]);
});
