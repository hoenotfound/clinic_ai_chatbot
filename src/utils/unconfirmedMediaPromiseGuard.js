"use strict";

// The reply is sent before optional promotional or result images. Even when
// the media selector later approves an image, Meta may reject the actual send.
// Never let an AI text response promise or claim that an attachment was sent.
const MEDIA_PROMISE = /(?:发|發|传|傳|送|分享).{0,35}(?:给你|給你|给您|給您|参考|參考|看看)|(?:图片|圖片|优惠|優惠|配套|套餐|资料|資料|详情|詳情|内容|內容).{0,35}(?:发|發|传|傳|分享).{0,22}(?:给你|給你|参考|參考|看看)|\\b(?:i(?:'ll| will|'ve| have)?|we(?:'ll| will|'ve| have)?|let me)\\b.{0,45}\\b(?:send|share|sent|forward)\\b.{0,55}\\b(?:photo|image|picture|graphic|offer|promo|details|package)\\b|\\b(?:sending|shared|sent)\\b.{0,35}\\b(?:the|your|some)\\b.{0,20}\\b(?:details|packages|offers|photos|images)\\b|\\b(?:saya|kami)\\b.{0,24}\\b(?:hantar|kongsikan)\\b.{0,45}\\b(?:gambar|promosi|tawaran|pakej)\\b/iu;
const EMPTY_LIST_CLAIM = /(?:有这(?:两|2)种|有以下(?:两|2)?种|(?:配套|套餐|packages?)\\s*(?:如下|以下|below)|these (?:two|2) (?:packages|offers))\\s*[:：]\\s*$/iu;

function guardUnconfirmedMediaPromise(reply, language = "zh") {
  const source = String(reply || "");
  if (!MEDIA_PROMISE.test(source) && !EMPTY_LIST_CLAIM.test(source.trim())) {
    return { reply: source, changed: false };
  }
  const chunks = source.split(/\\n+|(?<=[。！？!?])\\s*/u)
    .map(text => text.trim()).filter(Boolean);
  const safe = chunks.filter(text =>
    !MEDIA_PROMISE.test(text) && !EMPTY_LIST_CLAIM.test(text)
  ).join("\\n").trim();
  if (safe) return { reply: safe, changed: true };
  const locale = String(language || "").toLowerCase();
  const fallback = locale.startsWith("ms")
    ? "Saya boleh bantu semak butiran pakej dan harga yang tersedia 😊"
    : locale.startsWith("en")
      ? "I can help confirm the current package details and price 😊"
      : "我可以帮你确认目前的配套内容和价格哦 😊";
  return { reply: fallback, changed: true };
}

module.exports = { guardUnconfirmedMediaPromise };
