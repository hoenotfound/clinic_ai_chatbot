"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {scopeSecondaryRead}=require("../src/utils/secondaryContactRead");
const service=require("../src/services/whatsappSecondaryFollowUpService");
const marketing=require("../src/services/whatsappSecondaryMarketingFollowUpService");
const general=require("../src/services/neutroSecondaryGeneralMarketingSql");
const cases=[
 [service.CANDIDATES_SQL,9],[service.POTENTIAL_DUE_SQL,8],
 [marketing.CANDIDATES_SQL,8],[marketing.POTENTIAL_DUE_SQL,7],
 [marketing.EXTENDED_CANDIDATES_SQL,8],[marketing.EXTENDED_POTENTIAL_DUE_SQL,7],
 [general.CANDIDATES_SQL,9],[general.POTENTIAL_DUE_SQL,8],
];
test("every discovery variant narrows its first shortlist with bound IDs and retains all other SQL",()=>{
 for(const [sql,n] of cases){
  const params=Array(n).fill(null);
  const [scoped,values]=scopeSecondaryRead(sql,params,[11,22,11]);
  assert.deepEqual(values,[...params,[11,22]]);
  const addition=`${sql.includes('WHERE recent.created_at >')?'recent':'e'}.contact_id = ANY($${n+1}::bigint[]) AND `;
  assert.equal(scoped.replace(addition,''),sql);
  assert.ok(scoped.indexOf(addition)<scoped.indexOf(') recent_contact ON TRUE'));
  assert.deepEqual(scopeSecondaryRead(sql,params),[sql,params]);
 }
});
test("empty or invalid scopes cannot become a full scan",()=>{
 for(const ids of [[],[0],[-1],['11'],[1.5],Array(101).fill(1)])assert.throws(()=>scopeSecondaryRead(service.CANDIDATES_SQL,[],ids));
 assert.throws(()=>scopeSecondaryRead('SELECT 1',[],[11]));
});
