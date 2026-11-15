"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  CAMPAIGN_KEY, PREFILL, FOLLOWUP_PREFILL, isExactPrefill, campaignCreativeMatches,
  campaignDay, firstReply, hasCampaignConversation, isOtherTreatmentQuery,
  campaignContextReply, guardCampaignPriceConflicts, candidateIsCampaign,
  campaignFollowUp,
} = require("../src/utils/neutroBreastRm68Campaign");

const early = Date.parse("2026-11-15T01:00:00Z");
const dec6 = Date.parse("2026-12-06T00:01:00Z");
const expired = Date.parse("2026-12-06T16:00:00Z");
const creative = {
  headline: "胸部专业检查 RM68体验优惠",
  body: "胸部健康评估+脉冲波疗程 12月5日及6日",
};
const history = [
  { role: "user", content: PREFILL },
  { role: "assistant", content: firstReply(early) },
];
function run(text, now = early) {
  return campaignContextReply({ history: [...history, { role: "user", content: text }], customerText: text, now });
}

test("RM68 creative verification fails closed for unrelated ads", () => {
  assert.equal(CAMPAIGN_KEY, "neutro_breast_rm68_2026");
  assert.equal(isExactPrefill(PREFILL), true);
  assert.equal(isExactPrefill(FOLLOWUP_PREFILL), true);
  assert.equal(isExactPrefill(FOLLOWUP_PREFILL + " 我今天能预约吗？"), false);
  assert.equal(isExactPrefill(PREFILL + " 今天可以吗？"), false);
  assert.equal(campaignCreativeMatches(creative), true);
  assert.equal(campaignCreativeMatches({ headline: "脉冲波 RM388", body: "胸部护理" }), false);
  assert.equal(campaignCreativeMatches({ headline: "骨盆 RM68", body: "Pelvic care" }), false);
  assert.equal(campaignCreativeMatches({ headline: "胸部护理", body: "" }), false);
  assert.equal(campaignCreativeMatches({ headline: "胸部护理 RM688", body: "" }), false);
  assert.equal(campaignCreativeMatches({ adName: "Breast Care RM68 Trial" }), true);
  assert.equal(campaignCreativeMatches({ campaignName: "胸部护理 RM68" }), true);
  assert.equal(campaignCreativeMatches(null), false);
});

test("RM68 date options change on Malaysian calendar without inventing a booking", () => {
  assert.equal(campaignDay(early), "both");
  assert.equal(campaignDay(Date.parse("2026-12-05T15:59:59Z")), "both");
  assert.equal(campaignDay(Date.parse("2026-12-05T16:00:00Z")), "dec6");
  assert.equal(campaignDay(dec6), "dec6");
  assert.equal(campaignDay(expired), "expired");
  assert.match(firstReply(early), /12月5日（星期六）还是12月6日（星期日）/);
  assert.match(firstReply(dec6), /活动日期：12月6日/);
  assert.match(firstReply(dec6), /您12月6日（星期日）方便吗/);
  assert.doesNotMatch(firstReply(dec6), /12月5日（星期六）/);
  assert.doesNotMatch(firstReply(dec6), /12月5日 & 6日/);
  assert.match(firstReply(expired), /活动已经结束/);
  assert.doesNotMatch(firstReply(expired), /首次体验只需 RM68|名额有限/);
});

test("Only a genuine prior RM68 opening establishes campaign conversation", () => {
  assert.equal(hasCampaignConversation(history), true);
  assert.equal(hasCampaignConversation([
    { role: "user", content: FOLLOWUP_PREFILL },
    { role: "assistant", content: firstReply(early) },
  ]), true, "new opt-in-style enquiry keeps RM68 price continuity");
  assert.equal(hasCampaignConversation([{ role: "user", content: PREFILL }]), false);
  assert.equal(hasCampaignConversation([{ role: "user", content: PREFILL }, {
    role: "assistant", content: "Pulse Wave RM388 full-body"
  }]), false);
  assert.equal(hasCampaignConversation([{ role: "assistant", content: firstReply(early) }]), false);
});

test("RM68 follow-on queries preserve correct pricing, duration and event dates", () => {
  assert.match(run("这个多少钱？"), /RM68/);
  assert.doesNotMatch(run("这个多少钱？"), /RM388/);
  assert.match(run("请问这个是 RM388 吗？"), /RM388 属于另一项全身脉冲波护理优惠/);
  assert.match(run("做多久？"), /1小时30分钟/);
  assert.match(run("RM68 包括什么？"), /脉冲波/);
  assert.match(run("RM68 包括什么？"), /不等于医院的乳腺癌筛查/);
  assert.match(run("12月5日还有名额吗？", dec6), /12月6日/);
  assert.doesNotMatch(run("12月5日还有名额吗？", dec6), /12月5日/);
  assert.match(run("RM68 还有吗？", expired), /已于12月6日结束/);
  assert.equal(run("骨盆调理多少钱？"), null);
  assert.equal(run("3D 小颜术 RM488 多少钱？"), null);
  assert.equal(run("取消活动"), null);
  assert.equal(run("好的"), null);
  const changedTopic = [...history,
    { role: "user", content: "骨盆调理多少钱？" },
    { role: "assistant", content: "骨盆配套费用按当前优惠确认" },
    { role: "user", content: "多少钱？" },
  ];
  assert.equal(campaignContextReply({
    history: changedTopic, customerText: "多少钱？", now: early,
  }), null, "do not revive RM68 after customer switches treatments");
  assert.equal(isOtherTreatmentQuery("骨盆调理多少钱？"), true);
});

test("RM68 final reply guard removes cross-campaign RM388 terms only for relevant thread", () => {
  const check = (reply, customerText = "这个价钱多少？", now = early, h = history) =>
    guardCampaignPriceConflicts({ history: h, customerText, reply, now });
  assert.match(check("脉冲波 RM388，全程2小时15分钟"), /RM68/);
  assert.doesNotMatch(check("脉冲波 RM388，全程2小时15分钟"), /全程2小时15分钟/);
  assert.equal(check("骨盆 RM388", "骨盆调理多少钱？"), "骨盆 RM388",
    "explicit new treatment keeps its own price");
  assert.equal(check("一般 Pulse Wave RM388", "这个价钱多少？", early, []), "一般 Pulse Wave RM388");
  assert.match(check("首次体验 RM68", "这个价钱多少？", expired), /活动已于12月6日结束/);
  assert.doesNotMatch(check("12月5日有位", "活动哪天？", dec6), /12月5日/);
  assert.match(check("12月5日有位", "活动哪天？", dec6), /12月6日/);
});

test("RM68 follow-ups require anchored customer campaign and are text-only", () => {
  const candidate = {
    channel: "whatsapp",
    trigger_message_content: firstReply(early),
    recent_inbound_messages: [PREFILL],
    recent_service_messages: [PREFILL],
    ad_followup_source: "meta_ads",
    ad_followup_headline: creative.headline,
    ad_followup_body: creative.body,
  };
  assert.equal(candidateIsCampaign(candidate), true);
  const newPrefillCandidate = { ...candidate,
    recent_inbound_messages: [FOLLOWUP_PREFILL],
    recent_service_messages: [FOLLOWUP_PREFILL],
  };
  assert.equal(candidateIsCampaign(newPrefillCandidate), true);
  assert.match(campaignFollowUp({ candidate: newPrefillCandidate, now: early }).message, /RM68/);
  assert.doesNotMatch(campaignFollowUp({ candidate: newPrefillCandidate, now: early }).message, /RM388/);
  assert.equal(candidateIsCampaign({ ...newPrefillCandidate, ad_followup_source: "direct" }), false);
  assert.equal(candidateIsCampaign({ ...newPrefillCandidate,
    ad_followup_headline: "黄金脉冲技术 RM388", ad_followup_body: "脉冲波护理",
  }), false, "non-RM68 ad cannot enable the event");
  assert.match(campaignFollowUp({ candidate, now: early }).message, /RM68/);
  assert.match(campaignFollowUp({ candidate, now: early }).message, /1小时30分钟/);
  assert.doesNotMatch(campaignFollowUp({ candidate, now: early }).message, /RM388/);
  assert.match(campaignFollowUp({ candidate, now: dec6 }).message, /今天12月6日/);
  assert.deepEqual(campaignFollowUp({ candidate, now: expired }), { expired: true, message: null });
  assert.equal(candidateIsCampaign({ ...candidate, ad_followup_body: "一般疗程", ad_followup_headline: "脉冲波 RM388" }), false);
  assert.equal(candidateIsCampaign({ ...candidate, ad_followup_source: "direct" }), false);
  assert.equal(candidateIsCampaign({ ...candidate, recent_inbound_messages: ["Hello"], recent_service_messages: ["Hello"] }), true,
    "verified saved opener remains authoritative after customer replies");
  assert.equal(campaignFollowUp({ candidate: { ...candidate, recent_inbound_messages: ["骨盆调理多少钱？"] }, now: early }), null);
  assert.equal(campaignFollowUp({ candidate: { ...candidate, trigger_message_content: "您好，我们的脉冲波 RM388" }, now: early })?.expired, false);
});

test("Production paths include RM68 scoped continuation and follow-up guards", () => {
  const server = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
  const follow = fs.readFileSync(path.join(__dirname, "../src/services/followUpService.js"), "utf8");
  const fixed = fs.readFileSync(path.join(__dirname, "../src/utils/fixedAdFirstReply.js"), "utf8");
  assert.match(fixed, /campaignCreativeMatches\(metaAdContext\)/);
  assert.match(server, /campaignContextReply\(\{/);
  assert.match(server, /guardCampaignPriceConflicts\(\{/);
  assert.match(server, /neutro_breast_rm68_continuation_text_only/);
  assert.match(follow, /campaignFollowUp\(\{ candidate \}\)/);
  assert.match(follow, /neutro_rm68_campaign_expired/);
  assert.match(follow, /!rm68FollowUp && !originalHasPrice/);
});
