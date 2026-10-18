"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const clinicConfig = require("../src/config/clinicConfig");
const { safeServiceFromCustomer } = require("../src/utils/initialOfferReplyGuard");
const { serviceCandidates, findServicesInText } = require("../src/utils/conversationPromptContext");
const { resolveClarifiedPriceService } = require("../src/utils/priceClarificationContext");
const { resolveShadowPriceException, recentVerifiedPricingSession } = require("../src/utils/shadowPriceException");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");
const { ambiguousAssessmentOrTreatmentFeeReply } = require("../src/utils/complimentaryAssessmentExperience");

const now = Date.now(), day = 86400_000;
const services = [
  { name:"骨盆调理" },{ name:"徒手体态调理" },{ name:"3D 小颜术" },
  { name:"9D 逆龄抗衰" },{ name:"1对1体态评估" },
];
const serviceAliases = [
  { alias:"骨盆",officialService:"骨盆调理" },
  { alias:"骨盆调整",officialService:"骨盆调理" },
  { alias:"骨盆矫正",officialService:"骨盆调理" },
  { alias:"徒手矫正",officialService:"徒手体态调理" },
  { alias:"3D",officialService:"3D 小颜术" },
  { alias:"9D",officialService:"9D 逆龄抗衰" },
];
const promotions = [{
  name:"骨盆调理套餐",
  linkedService:"骨盆调理",
  sendOnPriceQuery:true,
  validFrom:"2000-01-01",
  validUntil:"2999-12-31",
  packages:[
    {name:"Package A",title:"尊享护理配套",imageUrl:"https://example.test/promo-images/30",
      caption:"本月限时优惠，原价优惠 RM488，优惠后仅需 RM3️⃣8️⃣8️⃣" },
    {name:"Package B",title:"女性护理配套",imageUrl:"https://example.test/promo-images/31",
      caption:"本月限时优惠，原价 RM388，现在只需 RM2️⃣8️⃣8️⃣" },
  ],
}];
const turn = (role,content,age,staff=false) => ({
  role,content,pricingCreatedAtMs:now-age,pricingStaffAuthored:staff,
});
const oldHistory = () => [
  turn("user","你好！我想了解你们骨盆的疗程",14*day),
  turn("assistant","欢迎咨询",14*day-15_000),
  turn("assistant","[Verified STAFF message] 我帮你跟进哦",13*day,true),
];
const freshPelvic = () => [
  ...oldHistory(),
  turn("user","Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊",80_000),
  turn("assistant","可以呀～我们的骨盆调理主要是徒手做骨盆和整体体态平衡 😊",76_000),
  turn("assistant",[{type:"text",text:"这个是我们顾客护理后的 Before & After，骨盆线条变化"},{type:"image",data:"synthetic"}],75_000),
  turn("assistant",[{type:"text",text:"再给你看一个顾客护理后的 Before & After 😊"},{type:"image",data:"synthetic"}],73_000),
  turn("user","疗程多少钱",60_000),
];
const config = (overrides={}) => ({
  customerText:"疗程多少钱",conversationHistory:freshPelvic(),
  services,serviceAliases,promotions,metaAdContext:null,
  complimentaryAssessmentExperienceEnabled:true,now,...overrides,
});
const oldSettings = clinicConfig.automatedFollowUp;
async function withAssessmentFirst(fn){
  clinicConfig.automatedFollowUp={
    ...oldSettings,assessmentFirstPricingEnabled:true,
    complimentaryAssessmentExperienceEnabled:true,
  };
  try {return await fn();} finally {clinicConfig.automatedFollowUp=oldSettings;}
}
async function media({ customerText, conversationHistory, selected }) {
  return resolvePricePromotionForReply({
    ...config(),customerText,conversationHistory,
    treatment:selected,verifiedServiceFromText:selected,
    verifiedShadowPriceService:selected,priceQuery:true,packageQuery:false,
    aiPricingEnabled:false,flagged:false,bookingReady:false,
    keywordReason:null,needsAttention:false,textSendSucceeded:true,
    contactId:93,language:"zh",
    wasPromoRecentlySent:async()=>false,
    hasUnconfirmedMediaDelivery:async()=>false,
  });
}

test("Kiwijiayee 16:42: new customer-led price enquiry survives 14-day-old staff history",async()=>{
  await withAssessmentFirst(async()=>{
    const context=config();
    const window=recentVerifiedPricingSession(context.conversationHistory,context.customerText,now);
    assert.equal(window.length,5);
    assert.equal(window[0].role,"user");
    const decision=resolveShadowPriceException(context);
    assert.equal(decision?.treatment,"骨盆调理");
    assert.equal(decision?.source,"recent_first_customer");
    assert.deepEqual(decision?.prices.map(p=>p.price),["RM388","RM288"]);
    const reply=ensureVerifiedPriceReply({
      ...context,reply:"请问你想了解哪一项疗程的价格呢？",
      treatment:decision.treatment,
      verifiedShadowPriceService:decision.treatment,
      clarifiedPriceService:decision.clarifiedPriceService,
      priceOnlyResponse:true,language:"zh",
    });
    assert.match(reply.reply,/Package A.*RM388/su);
    assert.match(reply.reply,/Package B.*RM288/su);
    assert.doesNotMatch(reply.reply,/请问你想了解哪一项/u);
    const images=await media({
      customerText:context.customerText,
      conversationHistory:context.conversationHistory,
      selected:decision.treatment,
    });
    assert.deepEqual(images?.packages.map(p=>p.name),["Package A","Package B"]);
  });
});

test("Kiwijiayee 16:43: 盆骨调整 answers the immediately prior bot price clarification",async()=>{
  await withAssessmentFirst(async()=>{
    const history=[
      ...freshPelvic(),
      turn("assistant","请问你想了解哪一项疗程的价格呢？我可以帮你确认 😊",56_000),
      turn("user","盆骨调整",20_000),
    ];
    assert.equal(safeServiceFromCustomer("盆骨调整",services,serviceAliases)?.name,"骨盆调理");
    assert.deepEqual(findServicesInText("盆骨调整",serviceCandidates(services,serviceAliases)),["骨盆调理"]);
    const clarified=resolveClarifiedPriceService({
      customerText:"盆骨调整",conversationHistory:history,services,serviceAliases,
    });
    assert.equal(clarified,"骨盆调理");
    const decision=resolveShadowPriceException(config({
      customerText:"盆骨调整",conversationHistory:history,
    }));
    assert.equal(decision?.source,"customer_price_clarification");
    assert.equal(decision?.treatment,"骨盆调理");
    assert.deepEqual(decision?.prices.map(p=>p.price),["RM388","RM288"]);
    const response=ensureVerifiedPriceReply({
      ...config(),customerText:"盆骨调整",conversationHistory:history,
      treatment:decision.treatment,clarifiedPriceService:decision.treatment,
      verifiedShadowPriceService:decision.treatment,
      reply:"Hi～欢迎咨询 😊",priceOnlyResponse:true,
    });
    assert.match(response.reply,/RM388/u);
    assert.match(response.reply,/RM288/u);
    assert.doesNotMatch(response.reply,/欢迎咨询/u);
    const images=await media({
      customerText:"盆骨调整",conversationHistory:history,
      selected:decision.treatment,
    });
    assert.deepEqual(images?.packages.map(p=>p.name),["Package A","Package B"]);
  });
});

test("盆骨 spelling must not be interpreted as unrelated service or a mixed treatment",()=>{
  for(const input of ["盆骨","盆骨调整","盆骨矫正","盆骨调理"]){
    assert.equal(safeServiceFromCustomer(input,services,serviceAliases)?.name,"骨盆调理");
  }
  assert.equal(safeServiceFromCustomer("盆骨和3D",services,serviceAliases),null);
  assert.equal(safeServiceFromCustomer("不想盆骨调理",services,serviceAliases),null);
  assert.equal(safeServiceFromCustomer("盆骨",services.filter(s=>s.name!=="骨盆调理"),serviceAliases),null);
});

test("price exception is bounded by newest session and verified staff boundaries",()=>{
  assert.equal(resolveShadowPriceException(config({
    conversationHistory:[...oldHistory(),...freshPelvic().slice(3,-1),
      turn("assistant","[Verified STAFF message] I replied",64_000,true),
      turn("user","疗程多少钱",60_000)],
  })),null,"recent human reply cannot be bypassed");
  const source=freshPelvic();
  source[source.length-2].pricingCreatedAtMs=now-2*day;
  assert.equal(resolveShadowPriceException(config({conversationHistory:source})),null,
    "stale or out-of-order media must not license a new quote");
  assert.equal(resolveShadowPriceException(config({
    customerText:"疗程多少钱",
    conversationHistory:[...oldHistory(),turn("user","疗程多少钱",10_000)],
  })),null,"only old staff and old ad do not authorize new pelvic quote");
  assert.equal(resolveShadowPriceException(config({
    customerText:"3D和盆骨多少钱",
    conversationHistory:[...freshPelvic().slice(0,-1),turn("user","3D和盆骨多少钱",10_000)],
  })),null,"mixed-service requests are not scoped to pelvis");
  assert.equal(resolveShadowPriceException(config({
    customerText:"我有糖尿病，疗程多少钱",
    conversationHistory:[...freshPelvic().slice(0,-1),turn("user","我有糖尿病，疗程多少钱",10_000)],
  })),null,"clinical risk remains blocked");
  assert.equal(resolveShadowPriceException(config({
    customerText:"多少钱",
    conversationHistory:[
      turn("user","我有糖尿病，想了解骨盆调理",40_000),
      turn("assistant","可以介绍骨盆调理",30_000),
      turn("user","多少钱",10_000),
    ],
  })),null,"a prior medical-history warning in this session must block automatic sales");
  assert.equal(resolveShadowPriceException(config({
    customerText:"评估多少钱",
    conversationHistory:[...freshPelvic().slice(0,-1),turn("user","评估多少钱",10_000)],
  })),null,"assessment fee must not be treated as pelvic full-treatment price");
});

test("Ashley: vague How much after body-treatment + free intro clarifies fees",()=>{
  const discussion=[
    turn("user","请问有筋膜放松吗？肩颈和腰部",4*3600_000),
    turn("assistant","我们这边主要做徒手体态调理，先安排1对1体态评估+体验",3*3600_000),
    turn("user","两者都有",80_000),
    turn("assistant","建议中医师先帮你做一个1对1的体态评估+体验，再做针对性的手法放松与调理",75_000),
    turn("user","How much",50_000),
  ];
  const message=ambiguousAssessmentOrTreatmentFeeReply("How much",discussion,"zh");
  assert.match(message,/assessment \+ introductory experience is free/iu);
  assert.match(message,/full treatment/iu);
  assert.match(message,/Did you mean/iu);
  assert.equal(resolveShadowPriceException(config({
    customerText:"How much",conversationHistory:discussion,
  })),null,"unpriced body service cannot inherit pelvic ad promotion");
  assert.equal(resolveShadowPriceException(config({
    customerText:"How much",conversationHistory:discussion,
    metaAdContext:{
      serviceHint:"骨盆调理",serviceHintSource:"ad_name",
      headline:"徒手整骨",body:"骨盆矫正与徒手矫正",
      attributedAt:new Date(now-3*3600_000).toISOString(),
    },
  })),null,"a pelvic ad must not override Ashley's explicit fascia/neck enquiry");
  assert.equal(ambiguousAssessmentOrTreatmentFeeReply("How much time",discussion,"en"),null);
  assert.equal(ambiguousAssessmentOrTreatmentFeeReply("How much",[
    ...discussion.slice(0,-2),
    turn("assistant","1对1体态评估+体验",75_000,true),
    turn("user","How much",50_000),
  ],"en"),null,"staff-authored invitation cannot be used for AI override");
});


test("the ambiguous free intro clarification is limited to clinics that enabled the offer",()=>{
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  assert.match(source,/clinicConfig\.businessType === "tcm_clinic" &&\s*clinicConfig\.automatedFollowUp\?\.complimentaryAssessmentExperienceEnabled === true/u);
});
