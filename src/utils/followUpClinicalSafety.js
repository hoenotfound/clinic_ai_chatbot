"use strict";

// AI and fixed follow-ups must not promise zero downtime, zero pain, an
// immediate return to work or no side effects for every customer.
// Reject only strong absolute claims, not cautious individualized guidance.
const UNSAFE_CLINICAL_PROMISE =
  /(?:基本(?:上)?|完全|绝对|絕對|保证|保證|肯定|几乎|幾乎|100%)\s*(?:是|都|可以|不用|不需要|没有|沒有|无|無)?\s*(?:没有|沒有|无|無|不需要|不用)\s*(?:任何|什么|什麼)?\s*(?:恢复期|恢復期|修复期|修復期|风险|風險|副作用|痛|疼痛)|(?:做完|护理后|護理後|疗程后|療程後).{0,18}(?:马上|立刻|立即|直接|一定).{0,22}(?:正常上班|正常工作|正常活动|正常活動|恢复日常|恢復日常)|(?:guaranteed|always|100%\s*guaranteed|zero|no)\s+(?:downtime|recovery(?:\s+time)?|pain|side\s+effects?|risks?)|(?:no|zero)\s+(?:recovery|downtime|side\s+effects?)\s+(?:at\s+all|for\s+everyone)/iu;
// Unqualified Chinese guarantees are unsafe even without words like "完全".
// Do not classify a question or a disclaimer as a promise.
const UNSAFE_CLINICAL_DIRECT =
  /(?:没有|沒有|无|無|零|不会有|不會有|不会出现|不會出現|绝无|絕無)\s*(?:任何|什么|什麼)?\s*(?:恢复期|恢復期|修复期|修復期|副作用|后遗症|後遺症|风险|風險|疼痛|痛(?:感)?)(?!\s*[?？])/iu;
const UNSAFE_IMMEDIATE_ACTIVITY =
  /(?:一般|通常|做完|护理后|護理後|疗程后|療程後).{0,16}(?:无需休息|無需休息|不用休息|不需要休息|无需请假|無需請假|直接上班|马上上班|立即上班|正常上班|照常工作)/iu;

// An enquiry about risks is not a promise that risks do not exist.
// Strip only bounded, genuinely interrogative risk phrases; a promise in
// another clause must still be checked independently.
const CLINICAL_RISK_QUESTION =
  /(?:(?:你想(?:知道|了解)|想问|想問|请问|請問)\s*)?(?:有没有|有沒有|会不会有|會不會有|是否有|是否会有|是否會有|有无|有無|会有|會有)\s*(?:恢复期|恢復期|修复期|修復期|副作用|后遗症|後遺症|风险|風險|疼痛|痛(?:感)?)(?:吗|嗎|呢|呀)?\s*[?？]?|(?:没有|沒有|无|無|不会有|不會有)\s*(?:恢复期|恢復期|修复期|修復期|副作用|风险|風險|疼痛|痛(?:感)?)(?:吗|嗎|呢|呀)\s*[?？]?/giu;
function hasUnsafeClinicalFollowUpClaim(message) {
  const copy = String(message || "").trim().replace(CLINICAL_RISK_QUESTION, "");
  // "Cannot guarantee zero downtime" is a safety disclaimer, NOT a
  // guarantee. Remove only this bounded negated phrase before looking for
  // a separate unsafe promise elsewhere in the same message.
  const withoutDisclaimer = copy.replace(
    /(?:不能|无法|無法|不會|不会|不)\s*(?:保证|保證|承诺|承諾)\s*(?:(?:完全|绝对|絕對|基本(?:上)?)\s*)?(?:没有|沒有|无|無|零)\s*(?:恢复期|恢復期|修复期|修復期|副作用|风险|風險|疼痛|痛)|(?:不(?:一定|代表)|并非|並非|并不是|並不是|不是|不能说|不能說)\s*(?:完全|绝对|絕對)?\s*(?:没有|沒有|无|無)\s*(?:恢复期|恢復期|修复期|修復期|副作用|风险|風險|疼痛|痛)|(?:cannot|can't|can\s+not|do\s+not|don't|never)\s+guarantee\s+(?:zero|no)\s+(?:downtime|recovery(?:\s+time)?|pain|side\s+effects?|risks?)/giu,
    ""
  );
  return UNSAFE_CLINICAL_PROMISE.test(withoutDisclaimer) ||
    UNSAFE_CLINICAL_DIRECT.test(withoutDisclaimer) ||
    UNSAFE_IMMEDIATE_ACTIVITY.test(withoutDisclaimer);
}


module.exports = { hasUnsafeClinicalFollowUpClaim };
