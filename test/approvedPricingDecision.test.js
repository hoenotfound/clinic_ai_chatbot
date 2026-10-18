"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveApprovedPricingDecision, resolveApprovedPricingAssessment, pricingConflictHistory } = require("../src/utils/approvedPricingDecision");
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
  assert.match(server,/const pricingApproval = resolveApprovedPricingAssessment\(/u);
  assert.match(server,/const approvedPricingDecision = pricingApproval.decision/u);
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
    // Production has 产后 -> 产后调理 as a separate alias. It must not
    // reinterpret "适合产后" in the pelvic description as a second treatment.
    const productionServices=[...services,{name:"产后调理",priceRange:""}];
    const productionAliases=[...serviceAliases,
      {alias:"产后",officialService:"产后调理"}];
    const selection=resolveNumberedPricingMenuSelection({
      customerText:"1",conversationHistory:history,
      services:productionServices,serviceAliases:productionAliases,now,
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
  // An explicit other *treatment* remains a conflict, unlike "适合产后".
  const postpartumServices=[...services,{name:"产后调理"}];
  const postpartumAliases=[...serviceAliases,
    {alias:"产后",officialService:"产后调理"}];
  const conflictingDescription=[price,clarify,list,
    t("assistant","1. 骨盆/体态调理（包括产后调理）\n2. 3D 小颜术\n你想了解哪项的价钱呢？",70),selected];
  assert.equal(resolveNumberedPricingMenuSelection({
    customerText:"1",conversationHistory:conflictingDescription,
    services:postpartumServices,serviceAliases:postpartumAliases,now,
  }),null);
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
  assert.equal(call.params[5],"unknown");
  assert.equal(call.params[6],"骨盆调理");
  assert.equal(call.params[7],"recent_first_customer");
  assert.equal(call.params[10],"all_graphics_already_sent");
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


test("price -> bot numbered menu -> 1 resolves without an extra list request", async()=>{
  const now=Date.now();
  const at=(role,content,ageSeconds)=>({
    role,content,pricingCreatedAtMs:now-ageSeconds*1000,pricingStaffAuthored:false,
  });
  const flow=[
    at("user","什么价钱呢？",90),
    at("assistant","我们有以下疗程：\n1. 骨盆/体态调理（适合产后、久坐）\n2. 3D 小颜术（轮廓）\n你想了解哪项的价钱呢？",60),
    at("user","1",30),
  ];
  const productionServices=[...services,{name:"产后调理"}];
  const productionAliases=[...serviceAliases,{alias:"产后",officialService:"产后调理"}];
  const selection=resolveNumberedPricingMenuSelection({
    customerText:"1",conversationHistory:flow,
    services:productionServices,serviceAliases:productionAliases,now,
  });
  assert.deepEqual(selection,{treatment:"骨盆调理",source:"numbered_price_menu"});
  const prices=verifiedPricesForService(selection.treatment,promotions,"1",flow,{
    clarifiedPriceService:selection.treatment,
  });
  const outcome=resolveApprovedPricingAssessment({
    mode:"shadow",numberedMenuDecision:{
      ...pelvicDecision,source:selection.source,prices,
      clarifiedPriceService:selection.treatment,
    },customerText:"1",conversationHistory:flow,
    services:productionServices,serviceAliases:productionAliases,resultMedia:[],now,
  });
  assert.equal(outcome.reason,"approved");
  assert.deepEqual(outcome.decision.prices.map(p=>p.price),["RM388","RM288"]);
  const reply=ensureVerifiedPriceReply({
    customerText:"1",reply:"你想了解哪项疗程？",
    treatment:selection.treatment,pricingDecision:outcome.decision,
    priceOnlyResponse:true,language:"zh",services:productionServices,
    serviceAliases:productionAliases,promotions,conversationHistory:flow,
  });
  assert.match(reply.reply,/RM388/u);
  assert.match(reply.reply,/RM288/u);
  const media=await resolvePricePromotionForReply(mediaOptions(
    outcome.decision,"1",flow,{verifiedNumberedSelection:selection.treatment}
  ));
  assert.deepEqual(media?.packages.map(p=>p.name),["Package A","Package B"]);
  for(const changed of [
    [flow[0],{...flow[1],pricingStaffAuthored:true},flow[2]],
    [{...flow[0],pricingCreatedAtMs:now-26*3600*1000},flow[1],flow[2]],
    [at("user","评估收费多少？",90),flow[1],flow[2]],
    [flow[0],flow[1],{...flow[2],pricingCreatedAtMs:null}],
    [flow[0],at("assistant","不是菜单",60),flow[2]],
  ]) {
    assert.equal(resolveNumberedPricingMenuSelection({
      customerText:"1",conversationHistory:changed,
      services:productionServices,serviceAliases:productionAliases,now,
    }),null);
  }
});

test("current verified treatment choice overrides stale unpriced related topic, not current conflict",()=>{
  const now=Date.now();
  const at=(role,content,age)=>({role,content,pricingCreatedAtMs:now-age*1000});
  const related=[{enabled:true,service:"骨盆调理",relatedServices:["徒手体态调理"]}];
  const extendedServices=[...services,{name:"徒手体态调理",priceRange:""}];
  const extendedAliases=[...serviceAliases,{alias:"整骨",officialService:"徒手体态调理"}];
  const old=at("user","我想了解整骨",25*3600);
  const menuSession=[
    at("user","什么价钱呢？",90),
    at("assistant","1. 骨盆/体态调理\n2. 3D 小颜术\n你想了解哪一项价格呢？",60),
    at("user","1",30),
  ];
  const source={...pelvicDecision,source:"numbered_price_menu"};
  const args={mode:"shadow",numberedMenuDecision:source,
    customerText:"1",services:extendedServices,
    serviceAliases:extendedAliases,resultMedia:related,now};
  assert.equal(resolveApprovedPricingAssessment({
    ...args,conversationHistory:[old,...menuSession],
  }).reason,"approved");
  assert.equal(resolveApprovedPricingAssessment({
    ...args,conversationHistory:[at("user","整骨多少钱",120),...menuSession],
  }).reason,"approved","current verified menu choice supersedes the earlier topic");
  assert.equal(resolveApprovedPricingAssessment({
    ...args,customerText:"整骨多少钱",conversationHistory:[old,...menuSession],
  }).reason,"related_treatment_conflict");
  const directChoice=[
    at("user","整骨不适合我，想做骨盆调理",90),
    at("assistant","好的，先评估适合程度",60),
    at("user","多少钱？",30),
  ];
  assert.equal(resolveApprovedPricingAssessment({
    mode:"enabled",aiDecision:{...pelvicDecision,source:"recent_customer"},
    customerText:"多少钱？",conversationHistory:[old,...directChoice],
    services:extendedServices,serviceAliases:extendedAliases,resultMedia:related,now,
  }).reason,"approved");
  assert.ok(pricingConflictHistory({
    candidate:source,conversationHistory:[old,...menuSession],
    services:extendedServices,serviceAliases:extendedAliases,now,
  }).length <= 3);
});

test("mixed treatment-frequency and price question retains safe non-price guidance",()=>{
  const result=ensureVerifiedPriceReply({
    customerText:"大概需要做几次呢？价钱呢？",
    reply:"具体做几次需要中医师评估后确认。\n价格我帮你核实。",
    treatment:"3D 小颜术",pricingDecision:threeDDecision,
    priceOnlyResponse:true,conversationHistory:history524,
    services,serviceAliases,promotions,resultMedia:[],language:"zh",
  });
  assert.match(result.reply,/具体做几次需要中医师评估后确认/u);
  assert.match(result.reply,/RM488/u);
  assert.doesNotMatch(result.reply,/价格我帮你核实/u);
  const standalone=ensureVerifiedPriceReply({
    customerText:"价钱呢？",
    reply:"你们也可以看看其他疗程。\n我发优惠图。",
    treatment:"3D 小颜术",pricingDecision:threeDDecision,
    priceOnlyResponse:true,conversationHistory:history524,
    services,serviceAliases,promotions,resultMedia:[],language:"zh",
  });
  assert.doesNotMatch(standalone.reply,/看看其他疗程|我发优惠图/u);
});

test("approved compound pricing never repeats invented sessions or guaranteed outcomes",()=>{
  const cases=[
    {
      language:"zh",customerText:"大概需要做几次呢？价钱呢？",
      reply:"做三次一定见效，而且完全改善不反弹！\n只需要2次就能保证完美脸型。",
      safe:/具体做几次需要中医师评估后确认/u,
      unsafe:/三次一定见效|2次|完全改善|不反弹|保证完美/u,
    },{
      language:"en",customerText:"How many sessions? What is the price?",
      reply:"Only 2 sessions will definitely fix your face permanently!",
      safe:/depends on your individual needs/u,
      unsafe:/2 sessions|definitely|permanently/u,
    },{
      language:"ms",customerText:"Berapa sesi? Berapa harga?",
      reply:"Pasti berhasil sepenuhnya selepas 3 sesi sahaja!",
      safe:/bergantung pada keadaan individu/u,
      unsafe:/3 sesi|Pasti berhasil/u,
    },
  ];
  for(const x of cases){
    const priced=ensureVerifiedPriceReply({
      customerText:x.customerText,reply:x.reply,
      treatment:"3D 小颜术",pricingDecision:threeDDecision,
      priceOnlyResponse:true,conversationHistory:history524,
      services,serviceAliases,promotions,resultMedia:[],language:x.language,
    });
    assert.match(priced.reply,/RM488/u,x.customerText);
    assert.match(priced.reply,x.safe,x.customerText);
    assert.doesNotMatch(priced.reply,x.unsafe,x.customerText);
  }
});

test("denied pricing and unavailable prices never preserve unsupported session counts",()=>{
  const reply="做三次一定见效，不用评估！";
  const denied=ensureVerifiedPriceReply({
    customerText:"大概需要做几次呢？价钱呢？",
    reply,treatment:null,pricingDecision:null,priceRequested:true,
    priceOnlyResponse:true,services,serviceAliases,promotions,
    conversationHistory:history524,language:"zh",
  });
  assert.match(denied.reply,/具体做几次需要中医师评估后确认/u);
  assert.doesNotMatch(denied.reply,/三次一定见效|不用评估/u);

  const unavailable=ensureVerifiedPriceReply({
    customerText:"大概需要做几次呢？价钱呢？",
    reply,treatment:"3D 小颜术",
    pricingDecision:{...threeDDecision,prices:[]},
    services,serviceAliases,promotions,conversationHistory:history524,
    language:"zh",
  });
  assert.match(unavailable.reply,/具体做几次需要中医师评估后确认/u);
  assert.doesNotMatch(unavailable.reply,/三次一定见效|不用评估/u);
  assert.match(unavailable.reply,/最新价格需要由门店帮你确认/u);
});

test("central pricing approval reports specific stage reasons without raw chat in audit",()=>{
  const normal={mode:"enabled",aiDecision:pelvicDecision,
    customerText:"多少钱",conversationHistory:history93,...base};
  assert.equal(resolveApprovedPricingAssessment(normal).reason,"approved");
  assert.equal(resolveApprovedPricingAssessment({...normal,mode:"off"}).reason,"mode_off");
  assert.equal(resolveApprovedPricingAssessment({...normal,marketingStopQuestion:true}).reason,"marketing_opt_out");
  assert.equal(resolveApprovedPricingAssessment({...normal,flagged:true}).reason,"review_or_booking");
  assert.equal(resolveApprovedPricingAssessment({...normal,customerText:"怀孕了多少钱"}).reason,"clinical_safety");
  assert.equal(resolveApprovedPricingAssessment({...normal,aiDecision:null}).reason,"no_verified_candidate");
  assert.equal(resolveApprovedPricingAssessment({...normal,aiDecision:{...pelvicDecision,treatment:"Invalid"}}).reason,"invalid_treatment_or_intent");
  assert.equal(resolveApprovedPricingAssessment({...normal,aiDecision:{...pelvicDecision,prices:[]}}).reason,"active_price_unverified");
});
