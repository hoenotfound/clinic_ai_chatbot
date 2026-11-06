const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { priceCheckingReply } = require("../src/utils/priceCheckingReply");

test("verified price acknowledgements preserve the original Chinese copy", () => {
  assert.equal(priceCheckingReply("latest_package", "zh"), "我帮你核对这项疗程的最新配套价格 😊");
  assert.equal(priceCheckingReply("treatment", "zh"), "我帮你核对这项疗程的价格 😊");
  assert.equal(priceCheckingReply("two_treatments", "zh"), "我帮你确认这两项护理各自的价格 😊");
  assert.equal(priceCheckingReply("two_packages", "zh"), "我帮你核对这两项配套的价格 😊");
});

test("pricing review text is localized in English and Malay without invented amounts", () => {
  for (const key of ["latest_package", "treatment", "two_treatments", "two_packages"]) {
    const en = priceCheckingReply(key, "en");
    const ms = priceCheckingReply(key, "ms");
    assert.match(en, /check the price|check the prices|check the latest package price/);
    assert.match(ms, /Saya semak harga/);
    assert.doesNotMatch(en + ms, /[\u3400-\u4dbf\u4e00-\u9fff]|RM\s*\d/gu);
  }
});

test("server uses the same language determined from customer turns for every fixed price reply", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
  for (const key of ["latest_package", "treatment", "two_treatments", "two_packages"]) {
    assert.ok(src.includes('priceCheckingReply("' + key + '", mediaLanguage)'));
  }
});
