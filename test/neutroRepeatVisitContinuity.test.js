"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveRepeatVisitPriceReply } = require("../src/utils/repeatVisitPriceReply");
const { guardAssessmentFirstPricingReply } = require("../src/utils/initialOfferReplyGuard");

const services = [
  {name: "3D 小颜术"}, {name: "9D 逆龄抗衰"},
  {name: "骨盆调理"}, {name: "1对1体态评估"},
];
const serviceAliases = [
  {alias: "3D小颜术", officialService: "3D 小颜术"},
  {alias: "9D", officialService: "9D 逆龄抗衰"},
];
const now = Date.now();
const turn = (role, content, seconds, staff = false) => ({
  role, content, pricingCreatedAtMs: now - 300_000 + seconds * 1000,
  pricingStaffAuthored: staff,
});
// Mirrors the actual Natalie 3 November discussion, using no customer data.
const thread = () => [
  turn("user", "Hi～想了解 Neutro Sense TCM 3D 小颜术，可以 WhatsApp 跟进我和发相关优惠～", 0),
  turn("assistant", "Hi～你是对我们的 3D 小颜术有兴趣对吗～", 2),
  turn("assistant", "这个是我们顾客完成一次【3D小颜术】后的 Before & After", 4),
  turn("user", "整体", 31),
  turn("assistant", "好的～3D小颜术主要就是徒手调整整体脸型和轮廓线条", 36),
  turn("user", "了解一下价格", 42),
  turn("assistant", "3D 小颜术目前的配套价格是 RM488", 48),
  turn("assistant", "【3D 小颜术】是一项非注射的徒手面部护理", 49),
  turn("user", "通常要多少次", 128),
  turn("assistant", "3D小颜术一般没有固定次数", 133),
  turn("user", "或多久一次", 135),
  turn("assistant", "可以先来做1对1体态评估，中医师再建议间隔", 141),
  turn("user", "等我出国回来再预约", 180),
  turn("assistant", "祝你出国旅途愉快，回来后再安排", 186),
  turn("user", "问下 如果第二次后 价格大概", 206),
];
const config = overrides => ({
  customerText: "问下 如果第二次后 价格大概",
  conversationHistory: thread(), services, serviceAliases,
  language: "zh", now, ...overrides,
});

test("Natalie regression: second-session price remains tied to customer-confirmed 3D, without quoting trial price", () => {
  const result = resolveRepeatVisitPriceReply(config());
  assert.equal(result?.treatment, "3D 小颜术");
  assert.match(result?.reply || "", /3D 小颜术/u);
  assert.match(result?.reply || "", /第二次/u);
  assert.match(result?.reply || "", /门店同事确认/u);
  assert.doesNotMatch(result?.reply || "", /RM488|RM888|欢迎咨询/u);
});

test("A question about second-session price never borrows an old ad or staff choice", () => {
  const noCustomerChoice = thread().slice(1);
  assert.equal(resolveRepeatVisitPriceReply(config({
    conversationHistory: noCustomerChoice,
  })), null);
  const switched = [...thread().slice(0, -1),
    turn("user", "现在改问9D", 195),
    turn("assistant", "9D 逆龄抗衰主要针对松弛", 196),
    turn("user", "问下 如果第二次后 价格大概", 206)];
  assert.equal(resolveRepeatVisitPriceReply(config({
    conversationHistory: switched,
  }))?.treatment, "9D 逆龄抗衰");
  assert.equal(resolveRepeatVisitPriceReply(config({
    customerText: "9D 第二次价格多少",
    conversationHistory: [...thread().slice(0,-1),
      turn("user", "9D 第二次价格多少", 206)],
  })), null, "newly named service is handled by separate verification");
  const withStaff = [...thread().slice(0, -1),
    turn("assistant", "[Verified STAFF message] I can help", 199, true),
    turn("user", "问下 如果第二次后 价格大概", 206)];
  assert.equal(resolveRepeatVisitPriceReply(config({
    conversationHistory: withStaff,
  })), null, "staff ownership cannot be overridden");
});

test("No repeat-price response for a budget, first-trial quote, topic reset or clinical review", () => {
  for (const text of ["有个预算", "第一次价格多少", "不要3D了，问第二次价格",
    "我有糖尿病，第二次价格多少"]) {
    assert.equal(resolveRepeatVisitPriceReply(config({
      customerText: text,
      conversationHistory: [...thread().slice(0,-1),turn("user",text,206)],
    })), null, text);
  }
  const stale = thread().map(turn => ({...turn,
    pricingCreatedAtMs:turn.pricingCreatedAtMs - 5 * 3600_000}));
  assert.equal(resolveRepeatVisitPriceReply(config({
    conversationHistory:stale,
  })), null, "old sessions cannot justify new treatment context");
});

test("Price guard cannot reset a live 3D conversation to the welcome message", () => {
  const base = thread().slice(0, -1);
  const budget = [...base, turn("user", "有个预算", 215)];
  const guarded = guardAssessmentFirstPricingReply({
    customerText: "有个预算",
    reply: "3D 小颜术第二次收费 RM888",
    conversationHistory: budget,
    services, serviceAliases, language: "zh",
    isFirstMessage: false, requireVerifiedTreatment: true,
  });
  assert.equal(guarded.replaced, true);
  assert.match(guarded.reply, /3D 小颜术|3D小颜术/u);
  assert.match(guarded.reply, /预算/u);
  assert.doesNotMatch(guarded.reply, /RM888|欢迎咨询/u);

  const face = [...base, turn("user", "整体脸型", 215)];
  const welcome = guardAssessmentFirstPricingReply({
    customerText: "整体脸型",
    reply: "Hi～欢迎咨询 😊\n你目前最想了解哪一种护理，或想改善哪方面呢？",
    conversationHistory: face,
    services, serviceAliases, language:"zh", isFirstMessage:false,
  });
  assert.equal(welcome.replaced,true);
  assert.match(welcome.reply,/3D 小颜术|3D小颜术/u);
  assert.doesNotMatch(welcome.reply,/欢迎咨询/u);
});

test("Price guard leaves genuine first contact and verified price paths intact", () => {
  const initial = guardAssessmentFirstPricingReply({
    customerText:"你好",reply:"Hi～欢迎咨询 😊",
    conversationHistory:[turn("user","你好",1)],services,serviceAliases,
    isFirstMessage:true,
  });
  assert.equal(initial.replaced,false);
  const verified = guardAssessmentFirstPricingReply({
    customerText:"3D 小颜术多少钱",reply:"3D 小颜术 RM488",
    conversationHistory:thread(),services,serviceAliases,
    treatment:"3D 小颜术",verifiedPricingIntent:true,
    isFirstMessage:false,
  });
  assert.equal(verified.replaced,false);
});
