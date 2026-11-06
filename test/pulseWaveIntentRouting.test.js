"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { hasCustomerServiceEnquiry } = require("../src/utils/customerEnquiryEvidence");
const {
  customerNamedServices,
  explicitServiceNamedByCustomer,
  resolveResultMediaForReply,
} = require("../src/utils/resultMediaTrigger");
const { planResultMediaPacing } = require("../src/utils/resultMediaPacing");

const service = "脉冲波调理";
const media = [{
  service, enabled: true, triggerMode: "service_enquiry", autoSendCount: 2,
  items: [
    { imageUrl: "/api/config/result-media/image/38", caption: "Pulse Wave example 1" },
    { imageUrl: "/api/config/result-media/image/39", caption: "Pulse Wave example 2" },
  ],
}];
const services = [
  { name: service },
  { name: "骨盆调理" },
];
const serviceAliases = [
  "脉冲", "脉冲波", "脉冲能量波", "脈衝能量波",
  "脉冲能量波护理", "pulse wave", "pulse energy wave",
  "rawatan pulse wave", "gelombang denyutan",
].map(alias => ({ alias, officialService: service }));

function options(customerText, overrides={}) {
  return {
    customerText, resultMedia: media, services, serviceAliases,
    treatment: null, serviceQuery: false, serviceQuerySource: null,
    priceQuery: false, packageQuery: false, flagged: false,
    bookingReady: false, keywordReason: null, needsAttention: false,
    textSendSucceeded: true, contactId: 314,
    wasMediaRecentlySent: async () => false,
    hasUnconfirmedMediaDelivery: async () => false,
    getMostRecentlySentMediaUrl: async () => null,
    ...overrides,
  };
}

test("Pulse Wave name and genuine treatment enquiries resolve to the configured service", async () => {
  for (const message of [
    "我想了解脉冲波", "我想了解脉冲能量波", "脉冲",
    "脉冲能量波", "脈衝能量波", "pulse wave",
    "I want to know about pulse energy wave", "rawatan pulse wave",
  ]) {
    assert.equal(hasCustomerServiceEnquiry(message), true, message);
    assert.deepEqual(customerNamedServices(media, message, serviceAliases, services), [service], message);
    assert.equal(explicitServiceNamedByCustomer(media, message, serviceAliases, services), service, message);
    const selected = await resolveResultMediaForReply(options(message));
    assert.equal(selected?.service, service, message);
    assert.equal(selected?.items?.length, 2, message);
    assert.equal(selected?.serviceQuerySource, "customer_message", message);
  }
});

test("Pulse Wave recognition preserves price-first, ambiguity, staff and duplicate safeguards", async () => {
  for (const message of ["脉冲波多少钱？", "我想了解脉冲波和骨盆调理", "脉冲波在哪里？"]) {
    assert.equal(explicitServiceNamedByCustomer(media, message, serviceAliases, services), null, message);
  }
  assert.equal(await resolveResultMediaForReply(options("我想了解脉冲波和骨盆调理")), null);
  assert.equal(await resolveResultMediaForReply(options("我想了解脉冲波", { needsAttention: true })), null);
  assert.equal(await resolveResultMediaForReply(options("我想了解脉冲波", { wasMediaRecentlySent: async () => true })), null);
  assert.deepEqual(planResultMediaPacing({
    customerText: "脉冲波多少钱？", promotionCount: 1, items: media[0].items,
  }).items, []);
});
