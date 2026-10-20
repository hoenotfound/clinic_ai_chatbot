"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const { safeServiceFromCustomer, guardAssessmentFirstPricingReply } =
  require("../src/utils/initialOfferReplyGuard");
const { resolveVerifiedPriceFollowUpService, isContextualPriceReference } =
  require("../src/utils/priceFollowUpContext");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");

const services = [
  { name:"骨盆调理", priceRange:"" },
  { name:"3D 小颜术", priceRange:"RM488" },
  { name:"徒手体态调理", priceRange:"" },
];
const serviceAliases = [
  { alias:"骨盆", officialService:"骨盆调理" },
  { alias:"3D", officialService:"3D 小颜术" },
  { alias:"整骨", officialService:"徒手体态调理" },
];
const promotions = [
  { name:"October pelvic", linkedService:"骨盆调理", sendOnPriceQuery:true,
    packages:[
      {name:"Package A",aliases:["A配套"],imageUrl:"https://example.test/a",
       caption:"本月限时优惠\nRM100 优惠券限时领取\n原价优惠 RM488\n优惠后仅需 RM388",
       mediaTranslations:{en:{caption:"Promo price RM488\nAfter voucher, only RM388"}}},
      {name:"Package B",aliases:["B配套"],imageUrl:"https://example.test/b",
       caption:"本月限时优惠 RM100 OFF\n原价 RM388\n现在只需 RM288"},
    ]},
  { name:"3D first trial", linkedService:"3D 小颜术", sendOnPriceQuery:true,
    imageUrl:"https://example.test/3d", caption:"关于3D疗程",
    followUpMessage:"🎊 限时优惠🥳\n💎只需 RM488\n(原价 RM1288)"},
];
const history = (...rows) => rows.map(([role,content])=>({role,content}));
const convoB = history(
  ["user","我想了解骨盆调理"],
  ["assistant","我们可以先了解您的需求"],
  ["user","我想知道 B配套包括什么"],
  ["assistant","B配套有骨盆和子宫护理"],
  ["user","这个多少钱？"],
);
const common = { services, serviceAliases, promotions };
function resolved(text, turns) {
  return resolveVerifiedPriceFollowUpService({
    customerText:text, conversationHistory:turns, ...common,
  })?.name || null;
}
async function withAssessmentFirst(callback) {
  const previous = config.automatedFollowUp;
  config.automatedFollowUp = {...previous, assessmentFirstPricingEnabled:true};
  try { return await callback(); }
  finally { config.automatedFollowUp = previous; }
}
function textReply(text,turns,offerName="骨盆调理") {
  const treatment=resolved(text,turns) ||
    safeServiceFromCustomer(text, services, serviceAliases)?.name || null;
  const reply=guardAssessmentFirstPricingReply({
    customerText:text,reply:"我们有 RM999 的配套",treatment,
    requireVerifiedTreatment:true,services,serviceAliases,
    conversationHistory:turns,language:"zh",resultMedia:[],
  }).reply;
  return ensureVerifiedPriceReply({
    customerText:text,reply,treatment,language:"zh",resultMedia:[],
    services,serviceAliases,promotions,conversationHistory:turns,
  });
}
async function media(text, turns, treatment) {
  // Match the real server: an AI-selected treatment is not proof that the
  // customer actually asked about that service. Independently resolve it.
  const verified = safeServiceFromCustomer(text, services, serviceAliases)?.name ||
    resolved(text, turns);
  return withAssessmentFirst(async()=>resolvePricePromotionForReply({
    priceQuery:false,packageQuery:false,
    treatment,verifiedServiceFromText:verified,
    customerText:text,conversationHistory:turns,services,serviceAliases,
    promotions,resultMedia:[],contactId:100,textSendSucceeded:true,
    wasPromoRecentlySent:async()=>false,
    hasUnconfirmedMediaDelivery:async()=>false,
  }));
}

test("customer-named pelvic service and Package B survive a deictic price question",async()=>{
  const text="这个多少钱？";
  assert.equal(isContextualPriceReference(text),true);
  assert.equal(resolved(text,convoB),"骨盆调理");
  const result=textReply(text,convoB);
  assert.equal(result.restored,true);
  assert.match(result.reply,/Package B.*RM288/su);
  assert.doesNotMatch(result.reply,/RM999|Package A|RM388/u);
  const images=await media(text,convoB,"骨盆调理");
  assert.deepEqual(images?.packages.map(x=>x.name),["Package B"]);
});

test("short 'B配套多少钱' uses recent pelvic service, never a CRM or model guess",async()=>{
  const turns=history(
    ["user","我想了解骨盆调理"],
    ["assistant","可以，帮你说明"],
    ["user","B配套多少钱？"],
  );
  assert.equal(resolved("B配套多少钱？",turns),"骨盆调理");
  assert.match(textReply("B配套多少钱？",turns).reply,/Package B.*RM288/su);
  assert.deepEqual((await media("B配套多少钱？",turns,"骨盆调理"))
    ?.packages.map(x=>x.name),["Package B"]);
  assert.equal(resolved("B配套多少钱？",history(["user","B配套多少钱？"])),null);
});

test("standalone Chinese Malay and English price questions keep a recent customer service",()=>{
  for(const text of ["多少钱？","Berapa?","price?","how much?","How much is it?","What is the price for that?"]) {
    const turns=history(["user","我想了解3D 小颜术"],["assistant","好呀"],["user",text]);
    assert.equal(resolved(text,turns),"3D 小颜术",text);
    assert.match(textReply(text,turns).reply,/RM488/u,text);
  }
});

test("ambiguous topics, marketing consent, refusals, photos and staff messages never grant pricing",async()=>{
  const scenarios=[
    history(["user","我想了解3D 和骨盆调理"],["assistant","好的"],["user","这个多少钱？"]),
    history(["user","骨盆调理"],["assistant","好的"],["user","换个话题聊地址"],["assistant","地址在PJ"],["user","这个多少钱？"]),
    history(["user","骨盆调理"],["assistant","好的"],["user","之后有优惠可以通知我"],["assistant","收到"],["user","这个多少钱？"]),
    history(["user","骨盆调理"],["assistant","好的"],["user",[{type:"image"}]],["assistant","照片收到"],["user","这个多少钱？"]),
    history(["user","骨盆调理"],["assistant","[Verified STAFF message] 好的"],["user","多少钱？"]),
    history(["user","整骨"],["assistant","好的"],["user","B配套多少钱？"]),
  ];
  for(const turns of scenarios){
    const text=turns.at(-1).content;
    assert.equal(resolved(text,turns),null,JSON.stringify(turns));
  }
  for(const text of ["How much longer?", "Berapa lama?", "我不要价钱", "全部疗程多少钱？"]){
    const turns=history(["user","骨盆调理"],["assistant","好的"],["user",text]);
    assert.equal(resolved(text,turns),null,text);
  }
});

test("latest explicit service wins, but a B package from another treatment cannot be borrowed",()=>{
  const changed=history(["user","我想了解骨盆调理"],["assistant","好的"],
    ["user","我想了解3D 小颜术"],["assistant","收到"],["user","B配套多少钱？"]);
  assert.equal(resolved("B配套多少钱？",changed),null);
  const price=history(["user","我想了解骨盆调理"],["assistant","好的"],
    ["user","我想了解3D 小颜术"],["assistant","收到"],["user","这个多少钱？"]);
  assert.equal(resolved("这个多少钱？",price),"3D 小颜术");
});

test("conditional voucher price is not promised to be unconditional or stackable",()=>{
  const turns=history(["user","我想了解骨盆调理"],["assistant","好的"],
    ["user","A配套多少钱？"]);
  const quote=textReply("A配套多少钱？",turns);
  assert.match(quote.reply,/Package A.*RM388/su);
  assert.match(quote.reply,/优惠券后的价格/u);
  assert.match(quote.reply,/须符合领取及使用条件/u);
  assert.doesNotMatch(quote.reply,/RM288|自动享有|肯定叠加/u);
  const bTurns=history(["user","骨盆调理"],["assistant","好的"],
    ["user","B配套多少钱？"]);
  assert.doesNotMatch(textReply("B配套多少钱？",bTurns).reply,/优惠券后的价格/u);
});


test("unconfigured or newly named treatments do not inherit an earlier pelvic price",async()=>{
  const histories=[
    history(["user","我想了解骨盆调理"],["assistant","好的"]),
    history(["user","我想了解骨盆调理"],["assistant","好的"],
      ["user","我想知道 B配套包括什么"],["assistant","我们可以介绍配套"]),
  ];
  const otherPriceQuestions=[
    "按摩多少钱？","这个按摩多少钱？","肩颈按摩多少钱？",
    "How much for a massage?","massage price?","Facial massage cost?",
    "Harga urutan berapa?","这个面部护理多少钱？",
  ];
  for(const prefix of histories){
    for(const text of otherPriceQuestions){
      const turns=[...prefix,{role:"user",content:text}];
      assert.equal(resolved(text,turns),null,text);
      const result=textReply(text,turns);
      assert.doesNotMatch(result.reply,/RM388|RM288|Package A|Package B/u,text);
      assert.equal(await media(text,turns,"骨盆调理"),null,text);
    }
  }
});

test("short referential price questions still resolve the explicitly discussed service",async()=>{
  const cases=["这个多少钱？","那个多少钱？","这个配套多少钱？",
    "How much is it?","What is the price for that?","Harga ini berapa?"];
  for(const text of cases){
    const turns=history(["user","我想了解骨盆调理 B配套"],["assistant","好的"],
      ["user",text]);
    assert.equal(resolved(text,turns),"骨盆调理",text);
    const quote=textReply(text,turns);
    assert.match(quote.reply,/Package B.*RM288/su,text);
    assert.doesNotMatch(quote.reply,/Package A.*RM388/su,text);
  }
});


function withTrustedPricingDates(turns, startAgoHours=3) {
  const start=Date.now()-startAgoHours*60*60*1000;
  turns.forEach((turn,i)=>Object.defineProperties(turn,{
    pricingCreatedAtMs:{value:start+i*60_000,enumerable:false},
    pricingStaffAuthored:{value:false,enumerable:false},
  }));
  return turns;
}

test("contact #613: weekday + pelvic package AND single-session price keeps verified treatment",async()=>{
  const text="Weekday.. 想知道配套及单次价钱😁";
  const turns=withTrustedPricingDates(history(
    ["user","Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊"],
    ["assistant","我们的骨盆调理主要是徒手体态护理，你可以先了解一下～"],
    ["user","小腹突出。。 可以知道调理一次的费用吗？"],
    ["assistant","目前骨盆调理单次费用需要团队确认哦"],
    ["user","调整骨盆"],
    ["assistant","目前骨盆调理单次的费用需要门店确认。"],
    ["assistant","Hi～关于小腹突出和骨盆调理，你一般 weekday 还是 weekend 比较方便来PJ？"],
    ["user",text],
  ));
  assert.equal(require("../src/utils/customerEnquiryEvidence").hasExplicitPriceRequest(text),true,
    "mixed weekday price enquiry must be recognized as a CURRENT explicit price request");
  assert.equal(safeServiceFromCustomer("调整骨盆",services,serviceAliases),null,
    "baseline alias detector overlaps 整骨 and 骨盆; narrow booking rule must disambiguate exact customer phrase");
  assert.equal(require("../src/utils/priceFollowUpContext").resolveBookingResponsePriceService({
    customerText:text,conversationHistory:turns,...common,
  })?.name,"骨盆调理","booking continuity helper must identify verified treatment");
  assert.equal(resolved(text,turns),"骨盆调理",
    "mixed booking answer must resolve from customer-authored treatment, not ad metadata");
  const quoted=textReply(text,turns);
  assert.equal(quoted.restored,true);
  assert.match(quoted.reply,/Package A.*RM388/su);
  assert.match(quoted.reply,/Package B.*RM288/su);
  assert.doesNotMatch(quoted.reply,/RM999|请问你想了解哪一项疗程/u);
  assert.deepEqual((await media(text,turns,"骨盆调理"))?.packages.map(x=>x.name),["Package A","Package B"]);
});

test("mixed scheduling/price reply never borrows an ad-only or bot-inferred service",()=>{
  const current="Weekday.. 想知道配套及单次价钱😁";
  assert.equal(resolved(current,withTrustedPricingDates(history(
    ["assistant","关于骨盆调理的护理，你平日还是周末比较方便？"],
    ["user",current],
  ))),null);
  assert.equal(resolved(current,withTrustedPricingDates(history(
    ["user","想了解价钱"],
    ["assistant","骨盆调理你平日还是周末比较方便？"],
    ["user",current],
  ))),null);
});

test("mixed booking/price context fails closed on staff, wrong service, new topic and stale timestamps",()=>{
  const current="Weekday.. 想知道配套及单次价钱😁";
  const clean=()=>withTrustedPricingDates(history(
    ["user","我想了解骨盆调理"],["assistant","骨盆调理可以先评估"],
    ["assistant","骨盆调理 weekday 还是 weekend 比较方便？"],["user",current],
  ));
  assert.equal(resolved(current,clean()),"骨盆调理");

  const staff=clean();
  staff.splice(2,0,{role:"assistant",content:"[Verified STAFF message] 请先别自动发价钱",pricingStaffAuthored:true,pricingCreatedAtMs:Date.now()});
  assert.equal(resolved(current,staff),null,"verified staff text breaks continuity");
  const structuredStaff=clean();
  const mediaStaff={role:"assistant",content:[{type:"text",text:"[Verified STAFF message] 看看先"}]};
  Object.defineProperties(mediaStaff,{pricingStaffAuthored:{value:true},pricingCreatedAtMs:{value:Date.now()}});
  structuredStaff.splice(2,0,mediaStaff);
  assert.equal(resolved(current,structuredStaff),null,"structured staff media breaks continuity");

  const different=withTrustedPricingDates(history(
    ["user","我想了解骨盆调理"],["assistant","好的"],
    ["user","现在我想了解3D 小颜术"],["assistant","骨盆调理 weekday 还是 weekend 比较方便？"],
    ["user",current],
  ));
  assert.equal(resolved(current,different),null,"last customer service may not be silently overridden");

  const topic=withTrustedPricingDates(history(
    ["user","我想了解骨盆调理"],["assistant","好的"],
    ["user","换个话题聊按摩"],["assistant","骨盆调理 weekday 还是 weekend 比较方便？"],
    ["user",current],
  ));
  assert.equal(resolved(current,topic),null);

  const ambiguous=withTrustedPricingDates(history(
    ["user","我想了解3D 小颜术 和 骨盆调理"],
    ["assistant","骨盆调理 weekday 还是 weekend 比较方便？"],
    ["user",current],
  ));
  assert.equal(resolved(current,ambiguous),null);

  const stale=withTrustedPricingDates(history(
    ["user","我想了解骨盆调理"],["assistant","骨盆调理 weekdays 还是 weekends?"],
    ["user",current],
  ),26);
  assert.equal(resolved(current,stale),null,"historical price context cannot be reused");

  const untrusted=history(
    ["user","我想了解骨盆调理"],["assistant","骨盆调理 weekdays 还是 weekends?"],
    ["user",current],
  );
  assert.equal(resolved(current,untrusted),null,"missing DB timestamps must fail closed");

  const unrelated="Weekday.. 想知道其他疗程及单次价钱";
  assert.equal(resolved(unrelated,withTrustedPricingDates(history(
    ["user","我想了解骨盆调理"],["assistant","骨盆调理 weekday 还是 weekend 比较方便？"],
    ["user",unrelated],
  ))),null);
});
