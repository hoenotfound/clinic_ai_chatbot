// Fixed acknowledgements for existing verified pricing-review branches.
// No change to pricing authority, package selection, or media eligibility.
const COPY = Object.freeze({
  latest_package: {
    zh: "我帮你核对这项疗程的最新配套价格 😊",
    en: "Let me check the latest package price for this treatment 😊",
    ms: "Saya semak harga pakej terkini untuk rawatan ini ya 😊",
  },
  treatment: {
    zh: "我帮你核对这项疗程的价格 😊",
    en: "Let me check the price of this treatment for you 😊",
    ms: "Saya semak harga rawatan ini untuk anda ya 😊",
  },
  two_treatments: {
    zh: "我帮你确认这两项护理各自的价格 😊",
    en: "Let me check the prices for both treatments 😊",
    ms: "Saya semak harga bagi kedua-dua rawatan ini ya 😊",
  },
  two_packages: {
    zh: "我帮你核对这两项配套的价格 😊",
    en: "Let me check the prices for both packages 😊",
    ms: "Saya semak harga bagi kedua-dua pakej ini ya 😊",
  },
});

function priceCheckingReply(type, language = "en") {
  const variants = COPY[type];
  if (!variants) throw new TypeError("Unsupported price acknowledgement type");
  const locale = ["en", "ms", "zh"].includes(language) ? language : "en";
  return variants[locale];
}

module.exports = { priceCheckingReply };
