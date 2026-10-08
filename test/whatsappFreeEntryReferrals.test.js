const test=require("node:test");
const assert=require("node:assert/strict");
const repo=require("../src/db/whatsappFreeEntryReferralsRepo");
const calls=[];
const db={async query(sql,values){calls.push({sql,values});return {rowCount:1}}};
test("Only actual inbound CTWA referral with ad evidence creates a distinct session",async()=>{
 calls.length=0;
 assert.equal(await repo.recordIfQualifying(7,88,{source:"meta_ads",sourceType:"ad",adId:"ad-12"},db),true);
 assert.equal(calls.length,1);
 assert.match(calls[0].sql,/ON CONFLICT \(origin_message_id\) DO NOTHING/);
 assert.deepEqual(calls[0].values,[88,7,null,"ad-12",null,null]);
 assert.equal(await repo.recordIfQualifying(7,89,{source:"meta_ads",sourceType:"post",adId:"ad-12"},db),false);
 assert.equal(await repo.recordIfQualifying(7,90,{source:"meta_ads",sourceType:"ad"},db),false);
 assert.equal(await repo.recordIfQualifying(7,91,{source:"organic",sourceType:"ad",adId:"ad-12"},db),false);
 assert.equal(calls.length,1);
});
