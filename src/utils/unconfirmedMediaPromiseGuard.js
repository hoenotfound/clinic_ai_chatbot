"use strict";

// Promo images are a separate optional send after the AI text, and can still
// be rejected by the provider. Remove claims of planned/completed attachments
// before sending the text, preserving independent factual clauses.
const CN_MEDIA_OBJECT = /(?:图片|圖片|优惠图|優惠圖|配套图|套餐图|图|圖|照片|配套(?:内容|資料|资料)|套餐(?:内容|資料|资料)|優惠(?:詳情|详情)|优惠(?:詳情|详情)|详情|詳情|资料|資料)/u;
// Only treat an image/detail as "sent" when wording identifies an actual
// transfer. A bare 发…了 pattern also matches 发红了, 发炎了 and 发黄了.
// The recipient/completion grammar below avoids suppressing descriptions of
// a customer's skin or the contents of a reference photo.
// Standalone 送 usually describes a complimentary gift, not an attachment.
// Keep 发送/發送 as delivery verbs, without suppressing free-gift offers.
const CN_DIRECT_SEND = /(?:发送|發送|转发|轉發|分享|传送|傳送|发|發|传|傳)(?![红紅炎癢痒熱热燒烧覺觉現现展生病作育誓])[^。！？!?；;\n]{0,24}?(?:给你|給你|给您|給您|给你们|給你們|过去|過去|过来|過來|供你参考|供你參考)/u;
const CN_ALREADY_SENT = /(?:已经|已經|刚刚|剛剛|刚才|剛才|已)[^。！？!?；;\n]{0,30}?(?:(?:发送|發送|转发|轉發|分享|传送|傳送)(?:给你|給你|给您|給您|过去|過去|出(?:去)?|了|过|過)?|(?:发|發|传|傳)(?:给你|給你|给您|給您|过去|過去|出(?:去)?|了|过(?:了)?|過(?:了)?))(?![红紅炎癢痒敏熱热])/u;
const CN_SENDER_SEND_MEDIA = /(?:我|我们|我們)[^。！？!?；;\n]{0,14}?(?:发送|發送|分享|转发|轉發|发|發|传|傳)(?![红紅炎癢痒熱热燒烧覺觉現现展生病作育誓])[^。！？!?；;\n]{0,20}?(?:图片|圖片|优惠图|優惠圖|配套图|套餐图|图|圖|照片|详情|詳情|资料|資料|配套|套餐|优惠|優惠)/u;
const CN_RECIPIENT_SEND_MEDIA = /(?:给你|給你|给您|給您|给你们|給你們)[^。！？!?；;\n]{0,14}?(?:发送|發送|分享|转发|轉發|发|發|传|傳)[^。！？!?；;\n]{0,18}?(?:图片|圖片|图|圖|照片|资料|資料|详情|詳情|配套|套餐|优惠|優惠)/u;
const EN_MEDIA_SEND = /\b(?:i(?:'ll| will|'ve| have)?|we(?:'ll| will|'ve| have)?|let me|already|just)\b.{0,48}\b(?:send|share|sent|forward|shared)\b.{0,70}\b(?:image|photo|picture|graphic|offer|promo|promotion|package|details)\b|\b(?:sending|shared|sent)\b.{0,48}\b(?:image|photo|picture|graphic|offer|promo|package|details)\b/iu;
const MS_MEDIA_SEND = /\b(?:saya|kami)\b.{0,35}\b(?:hantar|kongsikan|dah\s+hantar|sudah\s+hantar)\b.{0,55}\b(?:gambar|promosi|tawaran|pakej|butiran)\b/iu;
const EMPTY_LIST_CLAIM = /(?:有这(?:两|2)种|有以下(?:两|2)?种|(?:配套|套餐|packages?)\s*(?:如下|以下|below)|these (?:two|2) (?:packages|offers))\s*[:：]\s*$/iu;

function claimsMediaWasOrWillBeSent(text) {
  const value = String(text || "");
  return (CN_MEDIA_OBJECT.test(value) && (
    CN_DIRECT_SEND.test(value) || CN_ALREADY_SENT.test(value) ||
    CN_SENDER_SEND_MEDIA.test(value) || CN_RECIPIENT_SEND_MEDIA.test(value)
  )) || EN_MEDIA_SEND.test(value) || MS_MEDIA_SEND.test(value);
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
