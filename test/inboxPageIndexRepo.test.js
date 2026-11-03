"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {pool}=require("../src/db/db");
const {listInboxPageIndex}=require("../src/db/inboxPageIndexRepo");

test("page index scopes SQL before reading contact/message metadata",async t=>{
  const old=pool.query,oldMulti=process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
  const oldHide=process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;
  t.after(()=>{
    pool.query=old;
    if(oldMulti===undefined)delete process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
    else process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED=oldMulti;
    if(oldHide===undefined)delete process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;
    else process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS=oldHide;
  });
  process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED="true";
  process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS="true";
  let queries=0;
  pool.query=async(sql,args)=>{
    queries++;
    assert.deepEqual(args,["customer",[11,12]]);
    assert.match(sql,/WITH eligible_inbox_contacts AS MATERIALIZED/);
    assert.match(sql,/SELECT c.id FROM contacts c WHERE TRUE AND c.id = ANY\(\$2::integer\[\]\)/);
    assert.match(sql,/pending_ai_review_rows/,{invert:true});
    assert.doesNotMatch(sql,/media_base64|JSONB_AGG|STRING_AGG/);
    assert.match(sql,/ORDER BY c.needs_attention DESC,latest.created_at DESC NULLS LAST/);
    assert.match(sql,/POSITION\(\$1::text IN LOWER\(CONCAT_WS/);
    return{rows:[{contact_id:11,search_match:true}]};
  };
  const rows=await listInboxPageIndex({accessibleContactIds:[11,12],query:"Customer"});
  assert.equal(rows.length,1);
  assert.equal(queries,1);
  assert.deepEqual(await listInboxPageIndex({accessibleContactIds:[]}),[]);
  assert.equal(queries,1);
  await assert.rejects(listInboxPageIndex({accessibleContactIds:["11"]}),/Invalid Inbox access scope/);
});

test("non-coexistence deployments avoid new sender joins",async t=>{
  const old=pool.query,oldMulti=process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
  t.after(()=>{
    pool.query=old;
    if(oldMulti===undefined)delete process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
    else process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED=oldMulti;
  });
  process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED="false";
  pool.query=async(sql,args)=>{
    assert.deepEqual(args,[""]);
    assert.doesNotMatch(sql,/whatsapp_sender_accounts account/);
    assert.doesNotMatch(sql,/whatsapp_sender_conversations sc/);
    return{rows:[]};
  };
  assert.deepEqual(await listInboxPageIndex(),[]);
});
