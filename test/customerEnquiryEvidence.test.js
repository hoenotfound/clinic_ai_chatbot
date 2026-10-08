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
