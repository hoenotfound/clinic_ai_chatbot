"use strict";

// Promo images are a separate optional send after the AI text, and can still
// be rejected by the provider. Remove claims of planned/completed attachments
// before sending the text, preserving independent factual clauses.
const CN_MEDIA_OBJECT = /(?:图片|圖片|优惠图|優惠圖|配套图|套餐图|图|圖|照片|配套(?:内容|資料|资料)|套餐(?:内容|資料|资料)|優惠(?:詳情|详情)|优惠(?:詳情|详情)|详情|詳情|资料|資料)/u;

// Only transfer verbs can authorize stripping an unsent-media claim.
// "分享的图片", "发表", "开发", "发布", "发红" and gifts ("送按摩")
// describe something else. Keep punctuation as a hard clause boundary.
const CN_SEND_VERB = "(?:发送|發送|转发|轉發|传送|傳送|分享|(?<![开開研])(?:发|發)(?![布佈红紅炎癢痒熱热燒烧覺觉現现展生病作育誓表放起育黃黄])|传|傳)";
const CN_MEDIA_ITEM = "(?:图片|圖片|优惠图|優惠圖|配套图|套餐图|图|圖|照片|资料|資料|详情|詳情|配套|套餐)";
const CN_SAME_CLAUSE = "[^。！？!?；;\\n，,]";
const CN_DELIVERY_TO_RECIPIENT = new RegExp(
  CN_SEND_VERB + CN_SAME_CLAUSE + "{0,24}?(?:给你|給你|给您|給您|给你们|給你們|过去|過去|过来|過來|供你参考|供你參考)", "gu"
);
const CN_RECIPIENT_FIRST = new RegExp(
  "(?:给你|給你|给您|給您|给你们|給你們)" + CN_SAME_CLAUSE +
  "{0,14}?" + CN_SEND_VERB + CN_SAME_CLAUSE + "{0,18}?" + CN_MEDIA_ITEM, "gu"
);
// Bare "我们分享的图片" does not imply a send, but "我们会分享配套资料" does.
const CN_PLANNED_SEND = new RegExp(
  "(?:我|我们|我們|这边|這邊)" + CN_SAME_CLAUSE +
  "{0,12}?(?:会|會|将|將|准备|準備|马上|馬上|现在|現在|稍后|稍後|待会|待會|先|再)" +
  CN_SAME_CLAUSE + "{0,8}?" + CN_SEND_VERB +
  CN_SAME_CLAUSE + "{0,20}?" + CN_MEDIA_ITEM, "gu"
);
// "图片已经发了" and "资料我刚才转发了" assert completed sends.
// An unrelated "已经分享的图片" is not an outbound promise.
const CN_OBJECT_ALREADY_SENT = new RegExp(
  CN_MEDIA_ITEM + CN_SAME_CLAUSE +
  "{0,10}?(?:已经|已經|刚刚|剛剛|刚才|剛才|已)" + CN_SAME_CLAUSE +
  "{0,12}?" + CN_SEND_VERB + CN_SAME_CLAUSE +
  "{0,8}?(?:了|过|過|出去|出去了|过去|過去)", "gu"
);
const CN_SENDER_ALREADY_SENT = new RegExp(
  "(?:我|我们|我們)" + CN_SAME_CLAUSE +
  "{0,8}?(?:已经|已經|刚刚|剛剛|刚才|剛才|已)" + CN_SAME_CLAUSE +
  "{0,10}?" + CN_MEDIA_ITEM + CN_SAME_CLAUSE +
  "{0,10}?" + CN_SEND_VERB + CN_SAME_CLAUSE +
  "{0,6}?(?:出去|出去了|过去|過去|了)", "gu"
);
const CN_SEND_VERB_MATCH = new RegExp(CN_SEND_VERB, "gu");
const CN_DELIVERY_RULES = [
  CN_DELIVERY_TO_RECIPIENT, CN_RECIPIENT_FIRST, CN_PLANNED_SEND,
  CN_OBJECT_ALREADY_SENT, CN_SENDER_ALREADY_SENT,
];
const CN_NEGATION_BEFORE_DELIVERY =
  /(?:不是|并非|並非|不|没|沒|未|无|無|勿|别|別|尚未|还没|還沒|暂不|暫不|不会|不會|不能|无法|無法|无需|無需|不需要|不能够|不能夠|还不能|還不能|尚不能|不想|不打算)[^。！？!?；;\n，,]{0,14}$/u;

function hasNegatedChineseSend(text, verbIndex) {
  // Keep separate affirmative sends after a contrast ("但...会发新图").
  const prefix = text.slice(Math.max(0, verbIndex - 34), verbIndex)
    .split(/[。！？!?；;\n，,]/u).at(-1)
    .split(/(?:但是|不过|不過|然而|但)/u).at(-1);
  return CN_NEGATION_BEFORE_DELIVERY.test(prefix);
}

function claimsChineseMediaDelivery(value) {
  if (!CN_MEDIA_OBJECT.test(value)) return false;
  for (const rule of CN_DELIVERY_RULES) {
    for (const match of value.matchAll(rule)) {
      // Some patterns start with the recipient, customer or media object:
      // locate the transfer verb itself before testing surrounding negation.
      for (const verb of match[0].matchAll(CN_SEND_VERB_MATCH)) {
        const index = match.index + verb.index;
        if (!hasNegatedChineseSend(value, index)) return true;
      }
    }
  }
  return false;
}
const EN_MEDIA_SEND = /\b(?:i(?:'ll| will|'ve| have)?|we(?:'ll| will|'ve| have)?|let me|already|just)\b.{0,48}\b(?:send|share|sent|forward|shared)\b.{0,70}\b(?:image|photo|picture|graphic|offer|promo|promotion|package|details)\b|\b(?:sending|shared|sent)\b.{0,48}\b(?:image|photo|picture|graphic|offer|promo|package|details)\b/iu;
const MS_MEDIA_SEND = /\b(?:saya|kami)\b.{0,35}\b(?:hantar|kongsikan|dah\s+hantar|sudah\s+hantar)\b.{0,55}\b(?:gambar|promosi|tawaran|pakej|butiran)\b/iu;
const EMPTY_LIST_CLAIM = /(?:有这(?:两|2)种|有以下(?:两|2)?种|(?:配套|套餐|packages?)\s*(?:如下|以下|below)|these (?:two|2) (?:packages|offers))\s*[:：]\s*$/iu;

function claimsMediaWasOrWillBeSent(text) {
  const value = String(text || "");
  return claimsChineseMediaDelivery(value) || EN_MEDIA_SEND.test(value) ||
    MS_MEDIA_SEND.test(value);
}

function guardUnconfirmedMediaPromise(reply, language = "zh") {
  const source = String(reply || "");
  // Split clauses, not entire messages, so "Package A RM388，I'll send the
  // image" preserves the pricing fact that was already checked upstream.
  // Commas between numeric digits belong to money (RM1,288), not clauses.
  // Splitting there can corrupt the already-authorized price shown to a lead.
  const chunks = source.split(/(?<=[，;；。！？!?])|(?<=,)(?!\d)|\n+|(?<=\.)\s+(?=[A-Z])/u)
    .map(text => text.trim()).filter(Boolean);
  if (!chunks.some(part => claimsMediaWasOrWillBeSent(part) ||
      EMPTY_LIST_CLAIM.test(part))) return { reply: source, changed: false };

  const kept = chunks.filter(part =>
    !claimsMediaWasOrWillBeSent(part) && !EMPTY_LIST_CLAIM.test(part));
  const safe = kept.join("\n").trim();
  if (safe) return { reply: safe, changed: true };
  const locale = String(language || "").toLowerCase();
  const fallback = locale.startsWith("ms")
    ? "Saya boleh bantu semak butiran pakej dan harga yang tersedia 😊"
    : locale.startsWith("en")
      ? "I can help confirm the current package details and price 😊"
      : "我可以帮你确认目前的配套内容和价格哦 😊";
  return { reply: fallback, changed: true };
}

module.exports = { guardUnconfirmedMediaPromise, claimsMediaWasOrWillBeSent };
