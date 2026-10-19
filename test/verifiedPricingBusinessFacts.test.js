"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { appendRequestedBusinessFacts } =
  require("../src/utils/verifiedPricingBusinessFacts");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");

const configured = {
  branches: [{
    name: "Petaling Jaya (PJ)",
    address: "C-12-6, Dataran 3 Two Business Centre, Jalan 19, Section 19/1, 46300 Petaling Jaya, Selangor",
  }],
  hours: {
    general: "Tuesday–Friday 10am–8pm; Saturday–Sunday 10am–6pm",
    closed: "Monday closed",
  },
};
const verifiedDecision = {
  type: "price", treatment: "3D 小颜术", source: "recent_customer",
  prices: [{ name: "Main offer", price: "RM488" }],
};

function formattedPriceReply(question, language = "zh", draft = "我们在 PJ 哦。") {
  // The former bug: the model could include a location, but the verified
  // price replacement reduced the entire reply to only a canonical RM quote.
  return ensureVerifiedPriceReply({
    customerText: question,
    reply: draft,
    treatment: "3D 小颜术",
    pricingDecision: verifiedDecision,
    priceOnlyResponse: true,
    language,
    services: [{ name: "3D 小颜术" }],
    serviceAliases: [{ alias: "3D", officialService: "3D 小颜术" }],
    promotions: [{
      name: "3D First Trial", linkedService: "3D 小颜术",
      sendOnPriceQuery: true,
      imageUrl: "https://example.test/3d.jpg",
      caption: "3D First Trial 现在只需 RM488",
      pricing: {currency: "MYR", offer: 488, normal: 888},
    }],
    conversationHistory: [
      { role: "user", content: "Hi～想了解 Neutro Sense TCM 3D 小颜术" },
      { role: "assistant", content: "护理时间大约1小时30分钟。" },
      { role: "user", content: question },
    ],
    resultMedia: [],
  });
}

test("production #569 compound location + price preserves verified RM488 and full PJ address",()=>{
  const question = "请问地点在哪里？价钱多少？";
  const priced = formattedPriceReply(question);
  assert.match(priced.reply, /RM488/u);
  assert.doesNotMatch(priced.reply, /C-12-6/u, "price formatter formerly removed location");
  const result = appendRequestedBusinessFacts({
    customerText: question, reply: priced.reply, ...configured, language:"zh",
  });
  assert.match(result, /RM488/u);
  assert.match(result, /Petaling Jaya \(PJ\)/u);
  assert.match(result, /C-12-6, Dataran 3 Two Business Centre/u);
  assert.match(result, /46300 Petaling Jaya, Selangor/u);
  assert.doesNotMatch(result, /RM388|RM288/u);
});

test("English and Malay compound enquiries retain localized configured address",()=>{
  for(const [question,language,expected] of [
    ["Where is your clinic? How much is the 3D price?","en",/Address: C-12-6/u],
    ["Alamat kat mana? Berapa harga 3D?","ms",/Alamat: C-12-6/u],
  ]) {
    const priced = formattedPriceReply(question, language, "Here are the details 😊");
    const result = appendRequestedBusinessFacts({
      customerText: question,reply:priced.reply,language,...configured,
    });
    assert.match(result,/RM488/u);
    assert.match(result,expected);
    assert.equal(result.split("C-12-6").length - 1,1);
  }
});

test("current opening-hours question may accompany pricing but never invent hours",()=>{
  const question="3D价钱多少？营业时间是什么？";
  const result=appendRequestedBusinessFacts({
    customerText:question,reply:"3D 小颜术：RM488",
    ...configured,language:"zh",
  });
  assert.match(result,/RM488/u);
  assert.match(result,/Tuesday–Friday 10am–8pm/u);
  assert.match(result,/Monday closed/u);
  assert.doesNotMatch(result,/C-12-6/u,"hours-only does not append unsolicited location");
  const missing=appendRequestedBusinessFacts({
    customerText:question,reply:"RM488",branches:configured.branches,
    hours:{},language:"zh",
  });
  assert.equal(missing,"RM488");
});

test("does not append unsolicited, stale, duplicated, or unconfigured address",()=>{
  const priced="3D 小颜术：RM488";
  assert.equal(appendRequestedBusinessFacts({
    customerText:"价钱多少？",reply:priced,...configured,language:"zh",
  }),priced);
  assert.equal(appendRequestedBusinessFacts({
    customerText:"请问地点在哪里？价钱多少？",reply:priced,
    branches:[],hours:{},language:"zh",
  }),priced);
  const existing=priced+"\n地址："+configured.branches[0].address;
  assert.equal(appendRequestedBusinessFacts({
    customerText:"地点在哪里？价钱多少？",
    reply:existing,...configured,language:"zh",
  }),existing);
});

test("multibranch settings clarify rather than choosing the wrong branch",()=>{
  const branches=[
    ...configured.branches,
    { name:"Subang Jaya",address:"Configured Other Branch, Subang Jaya" },
  ];
  const unclear=appendRequestedBusinessFacts({
    customerText:"请问地点在哪里？价钱多少？",
    reply:"RM488",branches,language:"zh",
  });
  assert.match(unclear,/多个分行/u);
  assert.doesNotMatch(unclear,/C-12-6|Configured Other Branch/u);

  const selected=appendRequestedBusinessFacts({
    customerText:"3D 价钱多少？Petaling Jaya (PJ) 分行在哪里？",
    reply:"RM488",branches,language:"zh",
  });
  assert.match(selected,/C-12-6/u);
  assert.doesNotMatch(selected,/Configured Other Branch/u);
});

test("server only restores configured facts after an independently approved, quoted price",()=>{
  const server=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  assert.match(server,/const approvedPriceQuoted = Boolean\(approvedPricingDecision && priced\.restored/u);
  assert.match(server,/approvedPricingDecision\.prices\?\.some\(item/u);
  assert.match(server,/reply = appendRequestedBusinessFacts\(/u);
  assert.match(server,/branches: clinicConfig\.branches, hours: clinicConfig\.hours/u);
  assert.ok(server.indexOf("reply = appendRequestedBusinessFacts(") >
    server.indexOf("const priced = ensureVerifiedPriceReply("));
});

test("location wording is not inferred from anatomical position",()=>{
  const cases=[
    "脸的位置不对称，3D小颜术多少钱？",
    "小腹的位置凸，骨盆调理价钱多少？",
    "Where is the pain located? What is the price?",
    "The location of my jawline is unclear. What is the price?",
    "Sakit kat mana? Berapa harga rawatan?",
  ];
  for(const customerText of cases){
    const priced="3D 小颜术 RM488";
    assert.equal(appendRequestedBusinessFacts({
      customerText,reply:priced,...configured,language:"zh",
    }),priced,customerText);
  }
});

test("location intent retains correct business address in three languages",()=>{
  for(const [customerText,language] of [
    ["请问地点在哪里？价钱多少？","zh"],
    ["你们在哪里？3D小颜术多少钱？","zh"],
    ["你們的位置在哪裡？价钱多少？","zh"],
    ["Where is your clinic located? How much for 3D?","en"],
    ["Where are you located? What is the price?","en"],
    ["Klinik kat mana? Berapa harga 3D?","ms"],
  ]) {
    const priced=appendRequestedBusinessFacts({
      customerText,reply:"3D 小颜术 RM488",...configured,language,
    });
    assert.match(priced,/C-12-6, Dataran 3 Two Business Centre/u,customerText);
  }
});
