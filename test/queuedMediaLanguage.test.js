"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {latestQueuedLanguagePreference,resolveQueuedMediaLanguage,
  queuedMediaLanguageStillCurrent} = require("../src/utils/queuedMediaLanguage");
const zh="/api/config/result-media/image/38";
const en="/api/config/result-media/image/138";
const cfg={resultMedia:[{enabled:true,triggerMode:"service_enquiry",
  items:[{imageUrl:zh,caption:"脉冲波调理效果参考",
    mediaTranslations:{en:{imageUrl:en,caption:"Pulse wave treatment example"}}}]}]};
test("a newer explicit English request overrides older Chinese ad media",async()=>{
 const queries=[];
 const database={query:async(sql,args)=>{
   queries.push({sql,args});return{rows:[{content:"In English please"}]};
 }};
 assert.equal(await latestQueuedLanguagePreference(database,9120,20316),"en");
 assert.deepEqual(queries[0].args,[9120,20316]);
 assert.match(queries[0].sql,/created_at,newer.id/);
 assert.deepEqual(resolveQueuedMediaLanguage({
   imageUrl:zh,caption:"脉冲波调理效果参考",kind:"result",language:"en",config:cfg,
 }),{imageUrl:en,caption:"Pulse wave treatment example"});
});
test("a configured English caption can accompany the original approved photo",()=>{
 const translatedCaption="Individual Before & After example; results vary.";
 const onlyCaptions={resultMedia:[{enabled:true,triggerMode:"service_enquiry",
   items:[{imageUrl:zh,caption:"中文案例",
     mediaTranslations:{en:{caption:translatedCaption}}}]}]};
 assert.deepEqual(resolveQueuedMediaLanguage({
   imageUrl:zh,caption:"中文案例",kind:"result",language:"en",config:onlyCaptions,
 }),{imageUrl:zh,caption:translatedCaption});
});
test("no language switch leaves queued media unchanged and adds no new artwork",()=>{
 assert.deepEqual(resolveQueuedMediaLanguage({
   imageUrl:zh,caption:"原始说明",kind:"result",config:cfg,
 }),{imageUrl:zh,caption:"原始说明"});
});
test("missing approved translation suppresses an optional mismatched graphic",()=>{
 const noEnglish={resultMedia:[{enabled:true,triggerMode:"service_enquiry",
   items:[{imageUrl:zh,caption:"脉冲波减肥"}]}]};
 assert.equal(resolveQueuedMediaLanguage({
   imageUrl:zh,caption:"脉冲波减肥",kind:"result",language:"en",config:noEnglish,
 }),null);
 assert.equal(resolveQueuedMediaLanguage({
   imageUrl:zh,kind:"result",language:"en",config:{resultMedia:[]},
 }),null);
});
test("promotions use currently active language-specific artwork only",()=>{
 const conf={promotions:[{validFrom:"2026-01-01",validUntil:"2026-12-31",
   packages:[{imageUrl:"https://example.test/promo-zh.jpg",caption:"優惠",
     mediaTranslations:{en:{imageUrl:"https://example.test/promo-en.jpg",
       caption:"Special offer"}}}]}]};
 assert.deepEqual(resolveQueuedMediaLanguage({
   imageUrl:"https://example.test/promo-zh.jpg",kind:"promotion",language:"en",
   config:conf,now:new Date("2026-11-17T02:00:00Z"),
 }),{imageUrl:"https://example.test/promo-en.jpg",caption:"Special offer"});
});

test("final check cancels a selected English image when customer changes to Malay", async()=>{
  const requested=["In English please","Bahasa Melayu"];
  let calls=0;
  const database={query:async()=>({rows:[{content:requested[calls++]}]})};
  const selected=resolveQueuedMediaLanguage({imageUrl:zh,caption:"原本的文字",
    kind:"result",language:"en",config:cfg});
  assert.equal(await queuedMediaLanguageStillCurrent({
    database,contactId:9120,inboundMessageId:20316,
    imageUrl:zh,caption:"原本的文字",kind:"result",
    selectedMedia:selected,getConfig:()=>cfg,
  }),true);
  assert.equal(await queuedMediaLanguageStillCurrent({
    database,contactId:9120,inboundMessageId:20316,
    imageUrl:zh,caption:"原本的文字",kind:"result",
    selectedMedia:selected,getConfig:()=>cfg,
  }),false);
  assert.equal(calls,2);
});

test("final check fails closed when approved caption or image is revoked",async()=>{
  const database={query:async()=>({rows:[{content:"In English please"}]})};
  const selected=resolveQueuedMediaLanguage({imageUrl:zh,caption:"原文",
    kind:"result",language:"en",config:cfg});
  const revoked={resultMedia:[{enabled:false,triggerMode:"service_enquiry",
    items:cfg.resultMedia[0].items}]};
  assert.equal(await queuedMediaLanguageStillCurrent({
    database,contactId:12,inboundMessageId:13,
    imageUrl:zh,caption:"原文",kind:"result",
    selectedMedia:selected,getConfig:()=>revoked,
  }),false);
});
