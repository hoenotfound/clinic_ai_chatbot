const test = require("node:test");
const assert = require("node:assert/strict");

const {
  cleanScoredTreatmentInterest,
  inferConfiguredServiceFromText,
} = require("../src/utils/serviceInterest");

const config = {
  services: [
    { name: "徒手体态调理" },
    { name: "3D 小颜术" },
    { name: "9D 逆龄抗衰" },
    { name: "3D + 9D 组合" },
    { name: "骨盆调理" },
  ],
  serviceAliases: [
    { alias: "整骨", officialService: "徒手体态调理" },
    { alias: "小颜术", officialService: "3D 小颜术" },
    { alias: "3D", officialService: "3D 小颜术" },
    { alias: "9D", officialService: "9D 逆龄抗衰" },
    { alias: "3D+9D", officialService: "3D + 9D 组合" },
    { alias: "骨盆", officialService: "骨盆调理" },
    { alias: "盆骨", officialService: "骨盆调理" },
  ],
};

test("infers a configured service from Meta ad names", () => {
  assert.equal(inferConfiguredServiceFromText("骨盆 1", config), "骨盆调理");
  assert.equal(inferConfiguredServiceFromText("小颜术 5", config), "3D 小颜术");
  assert.equal(
    inferConfiguredServiceFromText("全身整骨 7-in1 ad - 妈妈", config),
    "徒手体态调理"
  );
});

test("prefers an explicitly configured combined service in an ad name", () => {
  assert.equal(
    inferConfiguredServiceFromText("3D+9D October Promo", config),
    "3D + 9D 组合"
  );
});

test("maps both component services to the configured combination service", () => {
  assert.equal(
    inferConfiguredServiceFromText("3D 小颜术 / 9D 逆龄抗衰", config),
    "3D + 9D 组合"
  );
  assert.equal(
    cleanScoredTreatmentInterest("3D 小颜术 / 9D 逆龄抗衰", config),
    "3D + 9D 组合"
  );
});

test("fails closed when the customer is explicitly comparing the two services", () => {
  assert.equal(
    inferConfiguredServiceFromText("Compare 3D or 9D", config),
    null
  );
});

test("returns null for an ad that does not identify a configured service", () => {
  assert.equal(inferConfiguredServiceFromText("October Promo V3", config), null);
});

test("canonicalizes scored treatment interest without inventing a value", () => {
  assert.equal(
    cleanScoredTreatmentInterest("  骨盆调理  ", config),
    "骨盆调理"
  );
  assert.equal(
    cleanScoredTreatmentInterest("customer wants 小颜术", config),
    "3D 小颜术"
  );
  assert.equal(
    cleanScoredTreatmentInterest("3D 小颜术 / 9D 逆龄抗衰", config),
    null
  );
  assert.equal(cleanScoredTreatmentInterest("   ", config), null);
  assert.equal(cleanScoredTreatmentInterest(null, config), null);
});
