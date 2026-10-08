const test = require("node:test");
const assert = require("node:assert/strict");
const {
  selectPricingOffer, evaluatePricingReminder, imageIdentity,
} = require("../src/utils/pricingReminderSelection");
const services = [{ name: "骨盆调理" }, { name: "3D 小颜术" }];
const promotions = [{
  name: "Pelvis", linkedService: "骨盆调理",
  packages: [
    { name: "Package A", imageUrl: "https://example.com/promo-images/30", caption: "RM388" },
    { name: "Package B", imageUrl: "https://example.com/promo-images/31", caption: "RM288" }
  ]
}, {
  name: "3D", linkedService: "3D 小颜术",
  imageUrl: "https://example.com/promo-images/32", caption: "RM488"
}];
const select = (candidate) => selectPricingOffer({promotions, candidate, services, language: "zh"});
test("requires explicit package for a multi-package service", () => {
  assert.equal(select({treatment_interest:"骨盆调理", recent_customer_messages:["骨盆调理"]}), null);
  assert.equal(select({treatment_interest:"骨盆调理", recent_customer_messages:["Package A please"]})?.caption, "RM388");
  assert.equal(select({treatment_interest:"骨盆调理", recent_customer_messages:["Package A or Package B?"]}), null);
});
test("does not resend a delivered or pending pricing image", () => {
  assert.equal(select({treatment_interest:"骨盆调理", recent_customer_messages:["Package A"], sent_media:[{
    media_url:"https://another-host.test/promo-images/30",content:"Already sent",delivery_status:"read"
  }]}),null);
  assert.equal(imageIdentity("https://foo.test/promo-images/30?x=1"), "/promo-images/30");
});
test("single package uses promotion graphic and caption", () => {
  assert.equal(select({treatment_interest:"3D 小颜术", recent_customer_messages:["Hello"]})?.caption, "RM488");
});

test("uncertain and failed media require staff review, never silent success", () => {
  for (const status of ["unknown", "failed", "pending"]) {
    const candidate = {
      treatment_interest:"3D 小颜术",
      recent_customer_messages:["3D please"],
      sent_media:[{media_url:"https://host.example/promo-images/32",
        content:"RM488", delivery_status:status, whatsapp_message_id:null}],
    };
    const result = evaluatePricingReminder({
      promotions, candidate, services, language:"zh"
    });
    assert.equal(result.offer, null);
    assert.equal(result.reason, "delivery_review");
  }
  const accepted = evaluatePricingReminder({
    promotions, services,
    candidate:{
      treatment_interest:"3D 小颜术",
      recent_customer_messages:["3D please"],
      sent_media:[{media_url:"https://host.example/promo-images/32",
        content:"RM488", delivery_status:"pending", whatsapp_message_id:"wamid.accepted"}],
    },
  });
  assert.equal(accepted.reason, "already_sent");
});

test("the latest clear treatment mention overrides an older CRM interest", () => {
  const result = select({
    treatment_interest:"骨盆调理",
    recent_customer_messages:["3D 小颜术 interested","骨盆调理 之前有兴趣"],
  });
  assert.equal(result?.serviceName, "3D 小颜术");
});

test("recognizes the combined 3D + 9D offer rather than sending a single-treatment price", () => {
  const comboServices = [...services, { name:"9D 逆龄抗衰" }, { name:"3D + 9D 组合" }];
  const comboPromos = [...promotions, {
    name:"Combined", linkedService:"3D + 9D 组合",
    imageUrl:"https://example.com/promo-images/33",caption:"Combo offer"
  }];
  const offer = selectPricingOffer({
    services: comboServices, promotions: comboPromos,
    candidate:{
      treatment_interest:"9D 逆龄抗衰",
      recent_customer_messages:["我要 3D + 9D 组合套餐"],
    },
  });
  assert.equal(offer?.serviceName,"3D + 9D 组合");
  assert.equal(offer?.caption,"Combo offer");
});
