const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hasCustomerPriceEnquiry,
  hasCustomerServiceEnquiry,
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
