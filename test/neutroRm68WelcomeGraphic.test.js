"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  configuredFirstReplyImage,firstReply,campaignContextReply,
} = require("../src/utils/neutroBreastRm68Campaign");
const {isCurrentApprovedClinicImage} = require("../src/services/whatsappSecondaryClinicMediaAuthorization");

const now = Date.parse("2026-11-16T03:00:00Z");
const baseConfig = {
  businessName: "Neutro Sense TCM Centre",
  adFirstReply: { enabled:true, replies:[], rm68ImageUrl:"/promo-images/41" },
  promotions: [{
    name:"Pulse Wave RM388",enabled:true,imageUrl:"/promo-images/37",
    caption:"General Pulse Wave RM388",linkedService:"脉冲波调理",
  }],
};
const resolve = (overrides={}, at=now) => configuredFirstReplyImage({
  config:{...baseConfig,...overrides},businessName:"Neutro Sense TCM Centre",now:at,
});

test("operator-controlled RM68 first graphic is strictly Neutro and expires after event",()=>{
  assert.equal(resolve(), "/promo-images/41");
  assert.equal(resolve({adFirstReply:{enabled:true,replies:[],rm68ImageUrl:""}}),null);
  assert.equal(resolve({adFirstReply:{enabled:true,replies:[],rm68ImageUrl:"https://example.test/promo-images/41"}}),null,
    "Do not allow arbitrary remote image hosts");
  assert.equal(resolve({adFirstReply:{enabled:true,replies:[],rm68ImageUrl:"/api/config/result-media/image/41"}}),null,
    "Never leak private Before & After image");
  assert.equal(resolve({adFirstReply:{enabled:true,replies:[],rm68ImageUrl:"/promo-images/37?x=1"}}),null);
  assert.equal(configuredFirstReplyImage({
    config:baseConfig,businessName:"Other Clinic",now,
  }),null);
  assert.equal(resolve({},Date.parse("2026-12-06T16:00:00Z")),null);
});

test("secondary media approval includes event-only image but not unrelated images",()=>{
  assert.equal(isCurrentApprovedClinicImage({
    imageUrl:"/promo-images/41",kind:"promotion",config:baseConfig,now:new Date(now),
  }),true);
  assert.equal(isCurrentApprovedClinicImage({
    imageUrl:"/promo-images/41",kind:"result",config:baseConfig,now:new Date(now),
  }),false);
  assert.equal(isCurrentApprovedClinicImage({
    imageUrl:"/promo-images/41",kind:"promotion",config:{...baseConfig,businessName:"Other Clinic"},
    now:new Date(now),
  }),false);
  assert.equal(isCurrentApprovedClinicImage({
    imageUrl:"/promo-images/41",kind:"promotion",config:baseConfig,
    now:new Date("2026-12-06T16:00:00Z"),
  }),false);
  assert.equal(isCurrentApprovedClinicImage({
    imageUrl:"/promo-images/37",kind:"promotion",config:baseConfig,now:new Date(now),
  }),true,"Regular RM388 promotion must remain available");
});

test("package is 90 minutes total including complimentary moxibustion",()=>{
  const welcome=firstReply(now);
  assert.match(welcome,/RM68/);
  assert.match(welcome,/45分钟/);
  assert.match(welcome,/免费赠送艾灸护理/);
  assert.match(welcome,/全程约 1小时30分钟/);
  assert.doesNotMatch(welcome,/2小时15分钟|2小时30分钟|RM388/);

  const history=[
    {role:"user",content:"你好！我想了解【胸部专业检查 RM68体验优惠】，请问还有名额吗？"},
    {role:"assistant",content:welcome},
    {role:"user",content:"赠送艾灸护理包括什么？"},
  ];
  const reply=campaignContextReply({history,customerText:"赠送艾灸护理包括什么？",now});
  assert.match(reply,/免费赠送艾灸护理/);
  assert.match(reply,/1小时30分钟/);
});

test("first-reply queue runs only after accepted text and uses verified campaign image",()=>{
  const server = fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  const anchor=server.indexOf('if (!reviewContinuationTextOnly && fixedAdFirstReply?.campaignKey === "neutro_breast_rm68_2026") {',server.indexOf('const auditResultMediaEarlyExit'));
  assert.ok(anchor>0,"find campaign image dispatch after text send");
  const block=server.slice(anchor,server.indexOf('if (rm68CampaignContinuationTextOnly)',anchor));
  assert.match(block,/sendOutcome\.sendResult\.success/);
  assert.match(block,/configuredFirstReplyImage/);
  assert.match(block,/getPublicImageMetadata/);
  assert.match(block,/secondaryAiConversation/);
  assert.match(block,/whatsappZeroCostGuard\.enabled\(\)/);
  assert.match(block,/kind: "promotion"/);
  assert.match(block,/inboundMessageId: savedInbound.id/);
  assert.doesNotMatch(block,/resolvePricePromotionForReply/);
});

test("first-reply graphic has an uploader but cannot enable remote URL input",()=>{
  const settings=fs.readFileSync(path.join(__dirname,"../portal-frontend/src/pages/Settings.jsx"),"utf8");
  const routes=fs.readFileSync(path.join(__dirname,"../src/routes/config.js"),"utf8");
  const repo=fs.readFileSync(path.join(__dirname,"../src/db/configRepo.js"),"utf8");
  assert.match(settings,/RM68 breast-care campaign graphic/);
  assert.match(settings,/rm68ImageUrl/);
  assert.match(settings,/allowUrl=\{false\}/);
  assert.match(routes,/rm68ImageUrl/);
  assert.match(repo,/rm68CampaignImageId/);
});
