"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {inboxPageModel,normalizeInboxPageFilters,openReplyWindow}=require("../src/services/inboxPaginationService");

function record(id,changes={}) {
  return {contact_id:id,name:"Person "+id,channel:"whatsapp",
    whatsapp_sender_key:id%2?"neutro":"neutro_secondary",
    whatsapp_sender_display_name:id%2?"Neutro Sense":"Secondary",
    created_at:"2026-10-01T10:00:00.000Z",
    last_message_at:"2026-11-02T09:00:00.000Z",
    latest_inbound_at:"2026-11-02T09:00:00.000Z",
    has_unreplied:false,is_unread:false,needs_attention:false,
    needs_follow_up:false,inbox_archived_at:null,mode:"ai",
    search_match:true,lead_owner_username:null, ...changes};
}
const now=Date.parse("2026-11-03T08:00:00Z");

test("first page holds at 100, with older accessible conversations in later pages",()=>{
  const rows=Array.from({length:245},(_,i)=>record(i+1));
  const first=inboxPageModel(rows,{}, {now,limit:100});
  assert.equal(first.total,245);
  assert.equal(first.ids.length,100);
  assert.equal(first.hasMore,true);
  assert.equal(first.nextOffset,100);
  const second=inboxPageModel(rows,{}, {now,offset:100,limit:100});
  const third=inboxPageModel(rows,{}, {now,offset:200,limit:100});
  assert.equal(third.ids.length,45);
  assert.equal(third.hasMore,false);
  assert.deepEqual([...first.ids,...second.ids,...third.ids],rows.map(x=>x.contact_id));
  assert.equal(first.statusCounts.all,245);
});

test("unread/unreplied/followup/archived filters reach contacts after first 100",()=>{
  const rows=Array.from({length:220},(_,i)=>record(i+1));
  rows[190].is_unread=true;
  rows[190].has_unreplied=true;
  rows[190].needs_follow_up=true;
  rows[191].inbox_archived_at="2026-11-03T07:00:00Z";
  const unread=inboxPageModel(rows,{status:"unread"},{now});
  assert.deepEqual(unread.ids,[191]);
  assert.equal(unread.statusCounts.unread,1);
  assert.deepEqual(inboxPageModel(rows,{status:"unreplied"},{now}).ids,[191]);
  assert.deepEqual(inboxPageModel(rows,{status:"follow-up"},{now}).ids,[191]);
  assert.deepEqual(inboxPageModel(rows,{status:"archived"},{now}).ids,[192]);
  assert.equal(inboxPageModel(rows,{}, {now}).total,219);
});

test("search matches a chat beyond the initial page, including archived items",()=>{
  const rows=Array.from({length:180},(_,i)=>record(i+1,{search_match:false}));
  rows[173].search_match=true;
  rows[173].inbox_archived_at="2026-11-01T10:00:00Z";
  const match=inboxPageModel(rows,{query:"old customer"},{now});
  assert.deepEqual(match.ids,[174]);
  assert.equal(match.statusCounts.archived,1);
  assert.equal(inboxPageModel(rows,{query:"old customer",status:"archived"},{now}).total,1);
  assert.equal(inboxPageModel(rows,{query:"old customer",sender:"neutro"},{now}).total,0);
});

test("sender, assignment, reply-window filters and contextual counts apply globally",()=>{
  const rows=[
    record(1,{lead_owner_username:"staff",has_unreplied:true}),
    record(2,{lead_owner_username:"other",latest_inbound_at:"2026-10-01T08:00:00Z"}),
    record(3,{lead_owner_username:"other",is_unread:true}),
    record(4,{lead_owner_username:null,inbox_archived_at:"2026-11-01T08:00:00Z"}),
  ];
  assert.equal(inboxPageModel(rows,{sender:"neutro"},{now}).total,2);
  assert.equal(inboxPageModel(rows,{assignment:"owner:other"},{now}).total,2);
  assert.equal(inboxPageModel(rows,{assignment:"mine"},{now,username:"staff"}).total,1);
  assert.equal(inboxPageModel(rows,{assignment:"unassigned"},{now}).total,0);
  const window=inboxPageModel(rows,{replyWindow:"open"},{now});
  assert.deepEqual(window.ids,[1,3]);
  assert.equal(window.replyWindowCounts.open,2);
  assert.equal(window.replyWindowCounts.expired,1);
  assert.equal(window.statusCounts.unreplied,1);
  assert.deepEqual(window.senderOptions.map(x=>x[0]),["neutro","neutro_secondary"].sort());
});

test("search/filter values and page sizes are bounded before querying Neon",()=>{
  const filters=normalizeInboxPageFilters({status:"garbage",sender:"bad!key",
    assignment:"owner:;DROP TABLE",query:"x".repeat(1000)});
  assert.equal(filters.status,"all");
  assert.equal(filters.sender,"all");
  assert.equal(filters.assignment,"all");
  assert.equal(filters.query.length,160);
  assert.equal(inboxPageModel(Array.from({length:110},(_,i)=>record(i+1)),{},
    {limit:99999}).ids.length,100);
  assert.equal(openReplyWindow(record(1,{channel:"whatsapp"}),now),true);
});
