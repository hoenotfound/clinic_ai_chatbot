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
  assert.equal(select({treatment_interest:"骨盆调理", recent_customer_messages:["骨盆调理"]}), null); // multi-graphic: use evaluatePricingReminder
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
  assert.equal(select({treatment_interest:"3D 小颜术", recent_customer_messages:["3D 小颜术 how much?"]})?.caption, "RM488");
});

test("uncertain and failed media require staff review, never silent success", () => {
  for (const status of ["unknown", "failed", "pending"]) {
    const candidate = {
      treatment_interest:"3D 小颜术",
      recent_customer_messages:["3D price please"],
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
      recent_customer_messages:["3D price please"],
      sent_media:[{media_url:"https://host.example/promo-images/32",
        content:"RM488", delivery_status:"pending", whatsapp_message_id:"wamid.accepted"}],
    },
  });
  assert.equal(accepted.reason, "already_sent");
});

test("the latest clear treatment mention overrides an older CRM interest", () => {
  const result = select({
    treatment_interest:"骨盆调理",
    recent_customer_messages:["3D 小颜术 价钱多少?","骨盆调理 之前有兴趣"],
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

test("pricing reminder is eligible on treatment interest even without a price question", () => {
  for (const phrase of ["我想了解 3D 小颜术效果", "骨盆调理适合产后吗", "3D 小颜术能不能改善下颚线", "Can I visit the clinic for an assessment?"]) {
    const service = phrase.includes("骨盆") ? "骨盆调理" : "3D 小颜术";
    const decision = evaluatePricingReminder({
      services, promotions, language: "zh",
      candidate: {treatment_interest:service,recent_customer_messages:[phrase]},
    });
    assert.equal(decision.reason, null);
    assert.ok(decision.offer, "Service interest is enough even without a price question");
  }
});

test("pricing intent supports Chinese, English, Malay, package selection and RM amounts", () => {
  for (const phrase of ["3D 价格多少", "3D how much?", "3D harga berapa", "3D RM488 还有吗", "3D punya promo?"]) {
    assert.equal(select({treatment_interest:"3D 小颜术",recent_customer_messages:[phrase]})?.caption,"RM488",phrase);
  }
  assert.equal(select({treatment_interest:"骨盆调理",recent_customer_messages:["Package B price please"]})?.caption,"RM288");
});

test("CRM treatment alone and ad attribution can still lead to a configured service pricing reminder", () => {
  for (const recent_customer_messages of [[],[],["3D 适合吗?"]]) {
    const decision=evaluatePricingReminder({
      services, promotions, language:"zh",
      candidate:{treatment_interest:"3D 小颜术",recent_customer_messages,ad_name:"3D RM488 promo"},
    });
    assert.equal(decision.reason,null);
    assert.equal(decision.offers.length,1);
  }
});

test("cancelled internal pricing claim does not count as a delivered or attempted graphic",()=>{
  const decision=evaluatePricingReminder({
    promotions, services,language:"zh",
    candidate:{
      treatment_interest:"3D 小颜术",
      recent_customer_messages:["3D 价钱多少"],
      sent_media:[{media_url:"https://host.example/promo-images/32",
        content:"RM488", delivery_status:"cancelled",whatsapp_message_id:null}],
    },
  });
  assert.equal(decision.reason,null);
  assert.equal(decision.offer?.caption,"RM488");
});

test("unclear pelvis package sends both A and B, while an explicit choice sends only that graphic",()=>{
  for(const recent_customer_messages of [[],["骨盆调理适合我吗"],["Package A or Package B?"]]){
    const result=evaluatePricingReminder({
      promotions,services,language:"zh",
      candidate:{treatment_interest:"骨盆调理",recent_customer_messages}
    });
    assert.equal(result.reason,null);
    assert.deepEqual(result.offers.map(x=>x.packageName),["Package A","Package B"]);
    assert.deepEqual(result.offers.map(x=>x.caption),["RM388","RM288"]);
    assert.notEqual(result.offers[0].imageUrl,result.offers[1].imageUrl);
  }
  const chosen=evaluatePricingReminder({
    promotions,services,language:"zh",
    candidate:{treatment_interest:"骨盆调理",recent_customer_messages:["Package B please"]}
  });
  assert.deepEqual(chosen.offers.map(x=>x.packageName),["Package B"]);
});

test("partially completed A/B reminder only returns the remaining unsent package",()=>{
  const result=evaluatePricingReminder({
    promotions,services,language:"zh",
    candidate:{treatment_interest:"骨盆调理",recent_customer_messages:["骨盆调理"],
      sent_media:[{media_url:"https://new.example/promo-images/30",content:"RM388",delivery_status:"sent"}]}
  });
  assert.deepEqual(result.offers.map(x=>x.packageName),["Package B"]);
});

test("unknown delivery for one pelvis package requires review before sending another",()=>{
  const result=evaluatePricingReminder({
    promotions,services,language:"zh",
    candidate:{treatment_interest:"骨盆调理",recent_customer_messages:[],
      sent_media:[{media_url:"https://new.example/promo-images/30",content:"RM388",delivery_status:"unknown"}]}
  });
  assert.equal(result.reason,"delivery_review");
  assert.deepEqual(result.offers,[]);
});

test("clinic-specific rule preserves opt-in price interest for other tenants",()=>{
  const options={promotions,services,language:"zh",
    candidate:{treatment_interest:"3D 小颜术",recent_customer_messages:["3D 适合我吗？"]}};
  const required=evaluatePricingReminder({...options,requirePricingInterest:true});
  assert.equal(required.offer,null);
  assert.equal(required.reason,"no_pricing_interest");
  assert.equal(evaluatePricingReminder({...options,requirePricingInterest:false}).offer?.caption,"RM488");
  const explicit=evaluatePricingReminder({...options,requirePricingInterest:true,
    candidate:{...options.candidate,recent_customer_messages:["3D price please"]}});
  assert.equal(explicit.offer?.caption,"RM488");
});

test("clinic-specific pelvic graphic option avoids changing another client's multi-package behavior",()=>{
  const candidate={treatment_interest:"骨盆调理",recent_customer_messages:["骨盆调理效果如何"]};
  const disabled=evaluatePricingReminder({
    promotions,services,candidate,sendBothPelvicPackages:false});
  assert.equal(disabled.offer,null);
  assert.equal(disabled.reason,"ambiguous_package");
  const enabled=evaluatePricingReminder({
    promotions,services,candidate,sendBothPelvicPackages:true});
  assert.deepEqual(enabled.offers.map(x=>x.packageName),["Package A","Package B"]);
  const chosen=evaluatePricingReminder({
    promotions,services,sendBothPelvicPackages:false,
    candidate:{...candidate,recent_customer_messages:["Package B please"]}});
  assert.deepEqual(chosen.offers.map(x=>x.packageName),["Package B"]);
});
