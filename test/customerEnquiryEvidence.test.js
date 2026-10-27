const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hasCustomerPriceEnquiry,
  hasCustomerServiceEnquiry,
  isContextualAdServiceEnquiry,
  isFollowUpConsentEnquiry,
} = require("../src/utils/customerEnquiryEvidence");

test("customer enquiry evidence rejects greetings, acknowledgements and admin-only turns", () => {
  for (const text of [
    "Hi", "English", "Hi, English", "中文", "BM", "OK", "okay", "Thanks",
    "Noted", "收到", "谢谢", "好", "👍", "terima kasih",
    "What is your address?", "location", "opening hours",
  ]) {
    assert.equal(hasCustomerPriceEnquiry(text), false, text);
    assert.equal(hasCustomerServiceEnquiry(text), false, text);
  }
  assert.equal(hasCustomerPriceEnquiry("I don't want pricing"), false);
  assert.equal(hasCustomerServiceEnquiry(null), false);
});

test("only a customer's actual current pricing/package question qualifies for promo media", () => {
  for (const text of [
    "How much is 3D?", "骨盆多少钱？", "Package B?", "什么优惠？",
    "berapa harga rawatan ini?", "do you have a package?",
    "English please, 骨盆调理 price?",
  ]) assert.equal(hasCustomerPriceEnquiry(text), true, text);

  for (const text of [
    "I am interested", "I would like to know more", "小腹凸",
    "More information please", "What treatment is this?",
    "I want to know how this works",
  ]) assert.equal(hasCustomerPriceEnquiry(text), false, text);
});

test("real service enquiries and relevant symptoms still qualify for result media", () => {
  for (const text of [
    "I am interested", "Tell me more about 3D", "想了解骨盆",
    "小腹凸", "产后骨盆", "Can you show before and after?",
    "Nak tahu rawatan", "3D", "9D", "English please, 骨盆调理 price?",
  ]) assert.equal(hasCustomerServiceEnquiry(text), true, text);
});

test("offering a treatment is not asking for a promotional offer", () => {
  assert.equal(hasCustomerPriceEnquiry("Do you offer pelvic treatment?"), false);
  assert.equal(hasCustomerServiceEnquiry("Do you offer pelvic treatment?"), true);
  assert.equal(hasCustomerPriceEnquiry("Any offers?"), true);
  assert.equal(hasCustomerPriceEnquiry("Current special offer?"), true);
  assert.equal(hasCustomerPriceEnquiry("Not interested in any promotion"), false);
  assert.equal(hasCustomerServiceEnquiry("Not interested in treatment"), false);
  assert.equal(hasCustomerServiceEnquiry("不要这个骨盆调理"), false);
});


test("Malay berapa distinguishes money from duration, session count and frequency", () => {
  const notPrice = [
    "Berapa lama rawatan ini?",
    "Berapa sesi diperlukan?",
    "Berapa kali perlu datang?",
    "Berapa minit untuk 3D?",
    "Berapa hari nak pulih?",
    "Berapa minggu sekali?",
    "Berapa umur boleh buat rawatan?",
    "Berapa?",
  ];
  for (const text of notPrice) assert.equal(hasCustomerPriceEnquiry(text), false, text);
  const priceQuestions = [
    "Berapa harga rawatan?",
    "Berapa kos untuk pelvis?",
    "Berapa ringgit 3D treatment?",
    "Berapa untuk rawatan ni?",
    "Berapa perlu bayar?",
    "Harga rawatan berapa?",
    "Rawatan ini RM berapa?",
  ];
  for (const text of priceQuestions) assert.equal(hasCustomerPriceEnquiry(text), true, text);
});

test("Administrative information/questions do not qualify as service-media enquiries", () => {
  for (const text of [
    "What is your contact information?",
    "Can I have your phone number?",
    "Could you give me your email address?",
    "More details about your opening hours please",
    "How do I find your clinic location?",
    "What is the payment method?",
    "Can you send your WhatsApp number?",
    "Need parking details",
    "Boleh tahu nombor telefon?",
    "Alamat klinik apa?",
    "请问联系方式是什么？",
    "请问营业时间？",
    "Parking information please",
  ]) {
    assert.equal(hasCustomerServiceEnquiry(text), false, text);
    assert.equal(hasCustomerPriceEnquiry(text), false, text);
  }
  for (const text of [
    "What are the details for 3D 小颜术, and your contact?",
    "I am interested in pelvic treatment, where is your branch?",
    "想了解骨盆调理，还有地址在哪里？",
  ]) assert.equal(hasCustomerServiceEnquiry(text), true, text);
});


test("English how-much questions distinguish duration and quantities from money", () => {
  for (const customerText of [
    "How much time does this treatment take?",
    "How much does this treatment take?",
    "How much does the facial treatment hurt?",
    "How much do I need to rest?",
    "How much would it take to recover?",
    "How much longer does this take?",
    "How much recovery time will I need after 3D?",
    "How much downtime is there?",
    "How much pain should I expect?",
    "How much water should I drink?",
    "How much weight can this remove?",
    "How much improvement will there be?",
    "How much time before my appointment?",
    "How much rest do I need?",
  ]) assert.equal(hasCustomerPriceEnquiry(customerText), false, customerText);

  for (const customerText of [
    "How much is the 3D treatment?",
    "How much for pelvic treatment?",
    "How much does 9D cost?",
    "How much does this treatment take, and how much does it cost?",
    "How much time does it take, and how much does it cost?",
    "How much recovery time and price?",
    "What is the first trial price?",
  ]) assert.equal(hasCustomerPriceEnquiry(customerText), true, customerText);
});


test("English waiting and recovery-time questions cannot unlock pricing graphics", () => {
  for (const text of [
    "How much is the recovery time?",
    "How much is my recovery time?",
    "How much is the treatment duration?",
    "How much is the appointment time?",
    "How much should I wait after treatment?",
    "How much can I wait before 3D?",
    "How much do I wait after the session?",
    "How much will it take to recover?",
  ]) {
    assert.equal(hasCustomerPriceEnquiry(text), false, text);
  }
  for (const text of [
    "How much is the 3D treatment?",
    "How much should I pay for 3D?",
    "How much does it cost to recover after treatment?",
    "How much is the recovery time and what is the price?",
    "How much should I wait and how much is the first trial?",
    "How much is the price of the 3D session?",
  ]) {
    assert.equal(hasCustomerPriceEnquiry(text), true, text);
  }
});

test("contextual Meta-ad enquiries are narrowly identified, independently of treatment attribution", () => {
  for (const text of [
    "Hello! Can I get more info on this?",
    "Can I know more about this?",
    "Hi, can I get some more details about it?",
    "Tell me more",
    "I'm interested",
    "I would like to know more about this",
    "More information please",
    "你好，想了解这个疗程",
    "Nak tahu tentang rawatan ini",
  ]) {
    assert.equal(isContextualAdServiceEnquiry(text), true, text);
    assert.equal(hasCustomerPriceEnquiry(text), false, text);
  }
  for (const text of [
    "Hi", "English", "OK", "Thanks", "I am not interested",
    "What is your contact information?", "Can I have more information about your opening hours?",
    "What is your address?", "Can I get more info on your pricing?",
    "What treatment is this?", "I would like to know more about 3D 小颜术",
  ]) assert.equal(isContextualAdServiceEnquiry(text), false, text);
});

test("CTWA promotional consent does not itself request pricing or result images", () => {
  const consent = [
    "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊",
    "Hi～想了解 Neutro Sense TCM 的骨盆调理，之后可以 WhatsApp 跟进我，有相关优惠也可以通知我 😊",
    "Hi! I'm interested in pelvic treatment. I'd also like to receive WhatsApp follow-ups and offers.",
    "Saya berminat rawatan pelvis. Boleh WhatsApp saya untuk susulan dan promosi berkaitan.",
  ];
  for (const text of consent) {
    assert.equal(isFollowUpConsentEnquiry(text), true, text);
    assert.equal(hasCustomerPriceEnquiry(text), false, text);
    assert.equal(hasCustomerServiceEnquiry(text), true, text);
  }
  const realRequests = [
    "现在骨盆调理多少钱？",
    "有优惠吗？现在配套多少钱？",
    "Hi～我对骨盆调理有兴趣，可以跟进我，有优惠也发我看看。现在多少钱？",
    "Hi～我对骨盆调理有兴趣，可以跟进我，有优惠也发我看看。可以看效果图吗？",
    "I'm interested in pelvic treatment. Do you have offers right now?",
  ];
  for (const text of realRequests) assert.equal(isFollowUpConsentEnquiry(text), false, text);
  assert.equal(hasCustomerPriceEnquiry(realRequests[2]), true);
  assert.equal(hasCustomerPriceEnquiry(realRequests[3]), false, "asking for results does not request prices");
  assert.equal(hasCustomerPriceEnquiry("现在骨盆调理多少钱？"), true);
  assert.equal(hasCustomerPriceEnquiry("Hi～我对骨盆调理有兴趣，可以跟进我，有什么优惠？"), true);
});

test("future WhatsApp opt-in does not mask current questions or trigger premature prices", () => {
  const { stripFutureFollowUpPermission } = require("../src/utils/customerEnquiryEvidence");
  const optIns = [
    "Hi～我想了解 Neutro Sense TCM 的骨盆调理。之后可以 WhatsApp 跟进我，有相关优惠也可以通知我 😊",
    "Hi～我现在想了解骨盆调理，可以跟进我，有优惠也发我看看",
    "我想先了解骨盆调理，可以跟进我，有优惠也发我看看",
    "可以先跟进我，有优惠也发我看看",
  ];
  for (const value of optIns) {
    assert.equal(hasCustomerPriceEnquiry(value), false, value);
    assert.equal(isFollowUpConsentEnquiry(value), true, value);
  }
  for (const value of [
    "Hi～我对骨盆调理有兴趣，可以跟进我，有优惠也发我看看。你们的套餐有哪些？",
    "Hi～我对骨盆调理有兴趣，可以跟进我，有优惠也发我看看。优惠是多少？",
    "Hi～我对骨盆调理有兴趣，可以跟进我，有优惠也发我看看。想看看优惠详情",
    "Hi～我对骨盆调理有兴趣，可以跟进我，有优惠也发我看看。我想知道配套价格",
    "Hi～我对骨盆调理有兴趣，可以跟进我，有优惠也发我看看。现在多少钱？",
  ]) {
    assert.equal(hasCustomerPriceEnquiry(value), true, value);
    assert.equal(isFollowUpConsentEnquiry(value), false, value);
  }
  const proof = "Hi～我对骨盆调理有兴趣，可以跟进我，有优惠也发我看看。可以看效果图吗？";
  assert.equal(hasCustomerPriceEnquiry(proof), false);
  assert.equal(isFollowUpConsentEnquiry(proof), false);
  assert.match(stripFutureFollowUpPermission(proof).text, /可以看效果图/);
  const noConsent = "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，不可以跟进我，有优惠也发我看看 😊";
  assert.equal(stripFutureFollowUpPermission(noConsent).hasFuturePermission, false);
  assert.equal(hasCustomerPriceEnquiry(noConsent), false);
});

test("immediate offers override future opt-in, but refusals and duration do not unlock prices", () => {
  const {stripFutureFollowUpPermission} = require("../src/utils/customerEnquiryEvidence");
  const original = "Hi～我想了解 Neutro Sense TCM 的骨盆调理。之后可以 WhatsApp 跟进我，有相关优惠也可以通知我 😊";
  for (const message of [
    original,
    original + "。护理需要多久？",
    "可以先跟进我，有优惠也发我看看",
    "Hi Neutro Sense TCM，我不希望接收 WhatsApp 优惠，只是想了解骨盆调理。",
    "Hi Neutro Sense TCM，我不希望你们 WhatsApp 跟进我，有相关优惠可以 WhatsApp 通知我。",
    "Hi Neutro Sense TCM，我不接受 WhatsApp 跟进，有优惠也可以通知我。",
    "Hi Neutro Sense TCM，可以跟进我，不过优惠现在不要发给我。",
  ]) assert.equal(hasCustomerPriceEnquiry(message), false, message);
  for (const message of [
    "Hi～我对骨盆调理有兴趣，可以跟进我，有优惠现在发给我看看 😊",
    "Hi～我对骨盆调理有兴趣，可以跟进我，有优惠马上发给我看看 😊",
    "Hi～我对骨盆调理有兴趣，可以跟进我，有优惠先发给我看看 😊",
    "Hi～我对骨盆调理有兴趣，可以跟进我，有优惠直接发给我看看 😊",
    "Hi～我对骨盆调理有兴趣，可以跟进我，有优惠现在就可以发吗 😊",
    original + "。骨盆套餐有哪些？",
    "Hi Neutro Sense TCM，不希望WhatsApp跟进我。现在骨盆套餐多少钱？",
  ]) assert.equal(hasCustomerPriceEnquiry(message), true, message);
  assert.equal(stripFutureFollowUpPermission(original).hasFuturePermission, true);
  assert.equal(stripFutureFollowUpPermission(
    "Hi Neutro Sense TCM，我不希望接收 WhatsApp 优惠，只是想了解骨盆调理。"
  ).hasFuturePermission, false);
});


test("declining one service does not swallow a separate explicit price request",()=>{
  for(const message of [
    "Hi～我不想做9D，请问3D 小颜术现在多少钱？",
    "Hi～我不要9D, 请问3D多少钱?",
    "我不想做9D，但骨盆多少钱？",
  ]) assert.equal(hasCustomerPriceEnquiry(message),true,message);

  for(const message of [
    "Hi～我不想做9D，想了解3D",
    "Hi～我不想做9D，也不想收优惠",
    "Hi～我不希望接收WhatsApp优惠，想了解骨盆",
    "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊",
  ]) assert.equal(hasCustomerPriceEnquiry(message),false,message);
});

test("general package introductions are not pricing enquiries but explicit option requests are", () => {
  for (const message of [
    "我想了解骨盆配套",
    "Hi～我想了解 Neutro Sense TCM 的骨盆配套。之后可以 WhatsApp 跟进我，有相关优惠也可以通知我 😊",
    "Tell me more about the pelvic package",
    "I want to know how Package B works",
    "Saya nak tahu tentang pakej pelvis",
    "Package B适合产后吗？",
  ]) assert.equal(hasCustomerPriceEnquiry(message), false, message);
  for (const message of [
    "骨盆套餐多少钱？", "套餐有哪些？", "你们有什么配套？",
    "do you have a package?", "Package B?", "有什么package？",
    "What packages are available?", "Berapa harga pakej ini?",
  ]) assert.equal(hasCustomerPriceEnquiry(message), true, message);
});

test("asking how a named package works is not a request for its price graphics", () => {
  for (const question of [
    "可以介绍一下骨盆配套吗？",
    "可以简单介绍骨盆套餐吗？",
    "我想看看骨盆配套是怎么做的",
    "介绍一下套餐内容",
    "Tell me the details of the pelvic package",
    "Could you explain the pelvic package?",
    "Nak tahu pakej rawatan ni macam mana",
  ]) assert.equal(hasCustomerPriceEnquiry(question), false, question);
  for (const question of [
    "骨盆套餐有哪些？", "你们有什么骨盆配套？",
    "What packages are available?", "package apa ada?",
    "请发我配套选项", "骨盆套餐多少钱?",
  ]) assert.equal(hasCustomerPriceEnquiry(question), true, question);
});


test("package description requests stay informational across Chinese, English and CTWA", () => {
  for (const text of [
    "Please send me package details",
    "Show me this treatment package",
    "Can you send me the pelvic package details?",
    "What are the package details?",
    "Can I get details about package B?",
    "可以发我骨盆配套介绍吗？",
    "请发我骨盆配套的内容",
    "你们的配套内容是什么？",
    "Hi～我想了解 Neutro Sense TCM 的骨盆配套。之后可以 WhatsApp 跟进我，有相关优惠也可以通知我 😊",
  ]) {
    assert.equal(hasCustomerPriceEnquiry(text), false, text);
  }
  for (const text of [
    "do you have a package?",
    "Package B?",
    "你们有什么配套？",
    "骨盆套餐有哪些？",
    "请发我配套选项",
    "What packages are available?",
    "Show me packages available",
    "package apa ada?",
    "现在骨盆多少钱？",
  ]) {
    assert.equal(hasCustomerPriceEnquiry(text), true, text);
  }
});


test("plain-language opt-outs never unlock immediate pricing media", () => {
  for (const value of [
    "No promotions please, just explain pelvic treatment",
    "No promos thanks",
    "No more offers please. How long does pelvic treatment take?",
    "Don't send me promotions, can you explain how 3D works?",
    "No discounts please, I only want service information",
    "Stop promotions. Can you tell me about the treatment?",
  ]) assert.equal(hasCustomerPriceEnquiry(value), false, value);
  for (const value of [
    "Any promotions for pelvic treatment?",
    "No promotions available today?",
    "What offers do you have?",
    "No promotions please, but what is the price of pelvic treatment?",
  ]) assert.equal(hasCustomerPriceEnquiry(value), true, value);
});


test("Malaysian Chinese WhatsApp price phrasing is monetary across casual Chinese and code-mixing", () => {
  const { hasExplicitPriceRequest, isStandalonePriceQuestion } =
    require("../src/utils/customerEnquiryEvidence");
  const messages = [
    "3D现在什么价？",
    "9D 什么价 ah?",
    "3D啥价",
    "请问3D报价",
    "可以给我报价吗？",
    "Can you quote me for 3D?",
    "9D quote me",
    "3D quote?",
    "3D RM几多？",
    "9D 幾多RM?",
    "3D價多少？",
    "3D 做一次要多少？",
    "9D 一次多少啊",
    "3D 1次大概多少?",
    "3D 1 session 多少?",
    "骨盆调理做一次几多？",
    "3D first trial 要多少？",
    "9D首次体验多少?",
    "3D几多?",
    "9D 幾多?",
    "3D价格how much ah?",
    "3D收费怎么算？",
    "9D price pls",
    "3D how much ya",
    "3D berapa harga?",
    "3D brp harga?",
    "3D brp RM?",
  ];
  for (const message of messages) {
    assert.equal(hasCustomerPriceEnquiry(message),true,message);
    assert.equal(hasExplicitPriceRequest(message),true,message);
  }
  for (const message of ["做一次要多少？","一次几多？","这个做一次要多少？","1 session 大概多少?"]) {
    assert.equal(isStandalonePriceQuestion(message),true,message);
    assert.equal(hasExplicitPriceRequest(message),true,message);
  }
});

test("Malaysian Chinese quantity, refusals, budgets and follow-up opt-ins cannot unlock price graphics", () => {
  const { hasExplicitPriceRequest, isStandalonePriceQuestion } =
    require("../src/utils/customerEnquiryEvidence");
  const notPrices=[
    "几多?", "幾多", "多少", "3D几多次?", "9D有几多种配套？",
    "3D 一次多少分钟?", "9D 一次多少天恢复?",
    "3D做一次多少个小时", "第一次体验多少分钟?",
    "3D first trial 几多次?", "3D 1 session 多少分钟?",
    "3D做一次需要多少次?", "我已经有报价了",
    "Quotation already received, thanks", "3D 我预算 RM300",
    "不需要价格", "不要报价", "我只想了解3D，不需要报价",
    "3D 价格不是问题", "3D price too expensive",
    "骨盆调理之后有优惠可以通知我",
    "Can you tell me how many sessions 3D takes?",
    "How much longer until I can do 9D?",
    "Berapa sesi rawatan 3D diperlukan?",
  ];
  for (const message of notPrices) {
    assert.equal(hasCustomerPriceEnquiry(message),false,message);
    assert.equal(hasExplicitPriceRequest(message),false,message);
  }
  for (const message of ["几多?","3D几多次?","一次多少分钟?"]) {
    assert.equal(isStandalonePriceQuestion(message),false,message);
  }
});


test("Malaysian Chinese benefit/quotation-of-text requests never become monetary enquiries", () => {
  const { hasExplicitPriceRequest } = require("../src/utils/customerEnquiryEvidence");
  for (const message of [
    "3D有什么价值？",
    "9D有什麼價值？",
    "3D什么价值比较高?",
    "9D 有啥价值比其他项目好？",
    "Can you quote a customer's feedback about 3D?",
    "Please quote this customer's message for me",
    "9D 一次多少人一起?",
    "3D 一次多少个部位?",
  ]) {
    assert.equal(hasCustomerPriceEnquiry(message), false, message);
    assert.equal(hasExplicitPriceRequest(message), false, message);
  }
  for (const message of [
    "3D 什么价？", "9D啥价", "3D体验价？",
    "3D優惠價?", "9D优惠价？", "3D体验价是多少?",
  ]) {
    assert.equal(hasCustomerPriceEnquiry(message), true, message);
    assert.equal(hasExplicitPriceRequest(message), true, message);
  }
});

test("different-treatment quote refusals preserve only a separate customer price request", () => {
  const { hasExplicitPriceRequest } = require("../src/utils/customerEnquiryEvidence");
  const positives=[
    "9D不要报价了，我想问3D多少钱？",
    "9D不需要报价，但3D优惠价多少？",
    "3D不要报价，9D多少钱?",
  ];
  for (const message of positives) {
    assert.equal(hasCustomerPriceEnquiry(message), true, message);
    assert.equal(hasExplicitPriceRequest(message), true, message);
  }
  for (const message of [
    "3D不要报价", "9D不需要报价。",
    "3D不要报价，9D的效果好不好？",
    "9D不要报价，不过我想了解3D的效果",
  ]) assert.equal(hasCustomerPriceEnquiry(message), false, message);
});
