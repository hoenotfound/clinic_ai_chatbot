const test = require("node:test");
const assert = require("node:assert/strict");
const { explicitPromotionConsent, businessIsNamed } = require("../src/utils/explicitWhatsAppConsent");

const clinic = { businessName: "Neutro Sense TCM Centre" };
test("classifies voluntarily sent Chinese CTWA follow-up + promotional opt-in", () => {
  for (const text of [
    "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊",
    "Hi～想了解 Neutro Sense TCM 的骨盆调理，之后可以 WhatsApp 跟进我，有相关优惠也可以通知我 😊",
    "Hi～想了解 Neutro Sense TCM 的骨盆调理，之后也愿意收到 WhatsApp 跟进和相关优惠 😊",
    "Hi～想了解 Neutro Sense TCM 的骨盆配套，之后有相关优惠也可以 WhatsApp 通知我～",
  ]) {
    const consent = explicitPromotionConsent(text, clinic);
    assert.equal(consent?.category, "MARKETING", text);
    assert.equal(consent?.scope, "treatment_followups_and_related_offers");
  }
});

test("explicit English and Malay follow-up offers can be documented", () => {
  const examples = [
    "Hi! I'm interested in Neutro Sense TCM treatments. I'd also like to receive relevant treatment information, follow-ups and offers from Neutro Sense TCM on WhatsApp.",
    "Hi! I'm interested in Neutro Sense TCM treatments. Feel free to WhatsApp me with follow-ups and related offers.",
    "Hi! Saya berminat dengan rawatan di Neutro Sense TCM. Saya juga bersetuju untuk menerima maklumat rawatan, susulan dan promosi berkaitan daripada Neutro Sense TCM melalui WhatsApp.",
    "Hi! Saya nak tahu tentang rawatan Neutro Sense TCM. Boleh WhatsApp saya untuk susulan dan promosi berkaitan.",
  ];
  for (const text of examples) {
    assert.equal(explicitPromotionConsent(text, clinic)?.category, "MARKETING", text);
  }
});

test("does not auto-opt-in genuine old Neutro Sense enquiries or non-consent", () => {
  for (const text of [
    "你好！我想了解你们骨盆的疗程",
    "Hello! Can I get more info on this?",
    "你好！我长期坐着会导致我的骨盆问题吗？",
    "我想了解【3D小颜术】疗程！",
    "Hi! Neutro Sense TCM, are there promotions for pelvic care?",
    "Hi Neutro Sense TCM, how much is the latest WhatsApp offer?",
    "Hi Neutro Sense TCM, I'd like details of your offers.",
    "Yes", "OK", "Hi! Please let us know how we can help you.",
    "Hi～我想了解 Neutro Sense TCM 的骨盆调理，可以 WhatsApp 跟进我，但不要发优惠。",
    "Hi Neutro Sense TCM, I don't want WhatsApp promotions.",
    "Hi Neutro Sense TCM, please WhatsApp me with offers from another clinic.",
    "Hi Neutro Sense TCM, click my link to WhatsApp and get offers.",
  ]) {
    assert.equal(explicitPromotionConsent(text, clinic), null, text);
  }
});

test("business identity is mandatory; consent cannot spill between tenants", () => {
  const text = "Hi Neutro Sense TCM, I'd like to receive WhatsApp follow-ups and offers.";
  assert.equal(explicitPromotionConsent(text, {businessName:"Different Clinic"}), null);
  assert.equal(explicitPromotionConsent(text, {businessName:""}), null);
  assert.equal(businessIsNamed(text, "Neutro Sense TCM Centre"), true);
  assert.equal(businessIsNamed("Hi Neutro Sense Team", "Neutro Sense TCM Centre"), false);
});

test("consent in the chat remains voluntary and must name this business", () => {
  const exact = "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊";
  assert.equal(explicitPromotionConsent(exact, clinic)?.category, "MARKETING");
  assert.equal(explicitPromotionConsent(exact, {businessName:"Different Clinic"}), null);
  for (const text of [
    "Hi Neutro Sense TCM, 骨盆调理有优惠吗？",
    "Hi Neutro Sense TCM, 可以跟进我，但是不用给我优惠。",
    "Hi Neutro Sense TCM, 我想了解骨盆调理。",
  ]) assert.equal(explicitPromotionConsent(text, clinic), null, text);
});

test("negated follow-up consent never authorizes WhatsApp marketing", () => {
  const rejected = [
    "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，不可以跟进我，有优惠也发我看看 😊",
    "Hi Neutro Sense TCM, 不可以 WhatsApp 跟进我，有优惠也发给我看看",
    "Hi Neutro Sense TCM, 不能跟进我，有优惠也发给我看看",
    "Hi Neutro Sense TCM, 请勿跟进我，有优惠也发我看看",
    "Hi Neutro Sense TCM, 可以跟进我，有优惠也发我看看，不过暂时不要发。",
    "Hi Neutro Sense TCM, 别跟进我，有优惠也发我看看",
  ];
  for (const value of rejected) {
    assert.equal(explicitPromotionConsent(value, clinic), null, value);
  }
  for (const value of [
    "Hi～我想了解 Neutro Sense TCM 的骨盆调理。之后可以 WhatsApp 跟进我，有相关优惠也可以通知我 😊",
    "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊",
  ]) assert.equal(explicitPromotionConsent(value, clinic)?.category, "MARKETING", value);
});

test("explicit refusal of WhatsApp follow-up or promotions never grants consent", () => {
  for (const message of [
    "Hi Neutro Sense TCM，我不希望接收 WhatsApp 优惠，只是想了解骨盆调理。",
    "Hi Neutro Sense TCM，我不希望你们 WhatsApp 跟进我，有相关优惠可以 WhatsApp 通知我。",
    "Hi Neutro Sense TCM，暂时不方便 WhatsApp 跟进我，但有相关优惠可以 WhatsApp 通知我。",
    "Hi Neutro Sense TCM，我不接受 WhatsApp 跟进，有优惠也可以通知我。",
    "Hi Neutro Sense TCM，我不想要收到 WhatsApp 优惠，请介绍一下骨盆调理。",
  ]) assert.equal(explicitPromotionConsent(message, clinic), null, message);
  assert.equal(explicitPromotionConsent(
    "Hi～我想了解 Neutro Sense TCM 的骨盆调理。之后可以 WhatsApp 跟进我，有相关优惠也可以通知我 😊",
    clinic
  )?.category, "MARKETING");
});
