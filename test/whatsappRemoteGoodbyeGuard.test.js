"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {remoteConversationGoodbyeSql}=require("../src/utils/whatsappRemoteGoodbyeGuard");
const service=require("../src/services/whatsappSecondaryFollowUpService");
const marketing=require("../src/services/whatsappSecondaryMarketingFollowUpService");
const general=require("../src/services/neutroSecondaryGeneralMarketingSql");

test("a real remote AI goodbye stops all secondary follow-ups and cannot cross sender or contact",()=>{
 const scope=remoteConversationGoodbyeSql();
 const statements=[
   service.CANDIDATES_SQL,service.RECHECK_SQL,
   marketing.CANDIDATES_SQL,marketing.RECHECK_SQL,
   marketing.EXTENDED_CANDIDATES_SQL,marketing.EXTENDED_RECHECK_SQL,
   general.CANDIDATES_SQL,general.RECHECK_SQL,
 ];
 for(const sql of statements){
  assert.ok(sql.includes(scope.trim()),
   "both discovery and last pre-send must use the exact shared guard");
  assert.match(sql,/closing_context\.conversation_id=sc\.id/);
  assert.match(sql,/closing_reply\.contact_id=c\.id/);
  assert.match(sql,/closing_reply\.delivery_status IN \('sent','delivered','read'\)/);
  assert.match(sql,/new_enquiry\.whatsapp_message_id IS NOT NULL/);
  assert.match(sql,/new_context\.conversation_id=sc\.id/);
  assert.match(sql,/imported\.sender_id=sa\.id/);
  assert.match(sql,/new_enquiry\.created_at,new_enquiry\.id/);
  assert.doesNotMatch(sql,/@@REMOTE_GOODBYE@@/);
 }
});

test("closing a remote chat does not permanently opt out a new readable enquiry",()=>{
 const sql=remoteConversationGoodbyeSql();
 assert.match(sql,/AND NOT EXISTS\(\s*SELECT 1 FROM messages new_enquiry/);
 assert.match(sql,/NOT LIKE\s*'📎/);
 assert.match(sql,/closing_reply\.created_at,closing_reply\.id/);
 assert.doesNotMatch(sql,/DELETE|UPDATE|INSERT INTO/i);
});

test("secondary scheduler never promotes a claimed video after a signed failure",()=>{
 const textSource=service.runOnce.toString();
 assert.match(textSource,/UPDATE whatsapp_sender_followup_attempts SET status='accepted'/);
 assert.match(textSource,/WHERE id=\$1 AND status='claimed'/);
 assert.match(textSource,/if\(finalized\.rowCount===1\)accepted\+\+/);
 const marketingSource=marketing.runOnce.toString();
 assert.match(marketingSource,/if\(finalized\.rowCount===1\)accepted\+\+/);
});
