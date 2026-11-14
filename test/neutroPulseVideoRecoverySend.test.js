"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const job=require("../src/services/neutroPulseVideoRecoverySend");
const env={
  NEUTRO_PULSE_RECOVERY_SEND_ENABLED:"true",
  CLIENT_SLUG:"neutro-sense-tcm",
  WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575",
  WHATSAPP_SECONDARY_WABA_ID:"1852014482431209",
  R2_BUCKET_NAME:"da-chatbot-neutro-sense-tcm-media"
};
test("recovery is off unless an exact Neutro sender plus one-shot opt-in matches",async()=>{
 assert.equal(job.enabled(env),true);
 for(const [key,bad] of [
  ["NEUTRO_PULSE_RECOVERY_SEND_ENABLED","false"],
  ["CLIENT_SLUG","wrong-client"],
  ["WHATSAPP_SECONDARY_SENDER_KEY","neutro"],
  ["WHATSAPP_SECONDARY_PHONE_NUMBER_ID","333"],
  ["WHATSAPP_SECONDARY_WABA_ID","444"],
  ["R2_BUCKET_NAME","wrong-bucket"],
 ])assert.equal(job.enabled({...env,[key]:bad}),false,key);
 assert.deepEqual(await job.run({env:{}}),{status:"disabled"});
});
test("new video is the full reencode, not any failed QuickTime asset",()=>{
 assert.match(job.KEY,/pulse-wave-h264-aac-full-reencode-v1\.mp4$/);
 assert.ok(!job.KEY.includes("1794652800000"));
 assert.ok(!job.KEY.includes("1794541729931"));
 assert.ok(job.CAPTION.includes("补发"));
 assert.match(job.FILENAME,/\.mp4$/);
});
test("repair is pinned to only two eligible contacts and never Peggy out of window",()=>{
 assert.deepEqual(job.CONTACTS.map(c=>c.id),[9063,9067]);
 assert.deepEqual(job.CONTACTS.map(c=>c.failedMessageId),[19579,19612]);
 assert.equal(job.CONTACTS.some(c=>c.id===9053),false);
});
test("freeform policy uses customer original 24h minus 2-minute margin",()=>{
 const now=new Date("2026-11-14T12:20:00Z");
 assert.equal(job.windowOpen("2026-11-13T18:36:24Z",now),true);
 assert.equal(job.windowOpen("2026-11-14T05:05:09Z",now),true);
 assert.equal(job.windowOpen("2026-11-13T03:04:07Z",now),false);
 assert.equal(job.windowOpen("2026-11-13T12:21:59Z",now),false);
 assert.equal(job.windowOpen("2026-11-14T12:30:00Z",now),false);
});
test("source contains delivery-gated sequential send, no Meta /messages bypass",async()=>{
 const fs=require("node:fs");
 const source=fs.readFileSync(require.resolve("../src/services/neutroPulseVideoRecoverySend"),"utf8");
 assert.match(source,/if\(outcome\.status!=="confirmed_delivered"\)break/);
 assert.match(source,/verified===true/);
 assert.match(source,/r\.matched=TRUE/);
 assert.match(source,/r\.delivery_status IN\('delivered','read'\)/);
 assert.match(source,/sendSecondaryStaffText\(\{/);
 assert.match(source,/origin:"staff",preSendCheck/);
 assert.match(source,/pg_try_advisory_lock/);
 assert.match(source,/await currentStatus\(entry\.id/);
 assert.match(source,/getSharedFollowUpMediaInfo\(KEY\)/);
 assert.match(source,/oldMessageRetryAllowed|no_replay|retry/i);
});
