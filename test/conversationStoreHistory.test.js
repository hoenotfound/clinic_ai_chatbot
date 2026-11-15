const test = require("node:test");
const assert = require("node:assert/strict");

const messagesRepo = require("../src/db/messagesRepo");
const conversationStore = require("../src/utils/conversationStore");

test("AI history can be bounded to the final message in the current debounce burst", async (t) => {
  const originalPage = messagesRepo.getMessagePageForContact;
  const originalRecent = messagesRepo.getMessagesForContact;
  const originalMedia = messagesRepo.getMessageMediaForContact;
  t.after(() => {
    messagesRepo.getMessagePageForContact = originalPage;
    messagesRepo.getMessagesForContact = originalRecent;
    messagesRepo.getMessageMediaForContact = originalMedia;
  });

  let pageOptions = null;
  messagesRepo.getMessagePageForContact = async (contactId, options) => {
    assert.equal(contactId, 42);
    pageOptions = options;
    return {
      rows: [
        { id: 98, role: "user", content: "hi", has_media_attachment: false },
        { id: 99, role: "assistant", content: "failed send", delivery_status: "failed", has_media_attachment: false },
        { id: 100, role: "user", content: "how much hifu", has_media_attachment: false },
      ],
      hasMore: false,
    };
  };
  messagesRepo.getMessagesForContact = async () => {
    throw new Error("unbounded history path should not be used");
  };
  messagesRepo.getMessageMediaForContact = async () => null;

  const history = await conversationStore.getHistoryForContact(42, {
    throughMessageId: 100,
  });

  assert.deepEqual(pageOptions, {
    limit: 20,
    beforeId: 101,
    includeMedia: false,
  });
  assert.deepEqual(history, [
    { role: "user", content: "hi" },
    { role: "user", content: "how much hifu" },
  ]);
});
test("AI excludes cancelled and pending-unsent pricing messages from both history modes", async (t) => {
  const originalPage = messagesRepo.getMessagePageForContact;
  const originalRecent = messagesRepo.getMessagesForContact;
  t.after(() => {
    messagesRepo.getMessagePageForContact = originalPage;
    messagesRepo.getMessagesForContact = originalRecent;
  });
  const rows = [
    { id: 1, role: "user", content: "How much?", has_media_attachment: false },
    { id: 2, role: "assistant", content: "Unsеnt RM388 graphic", pricing_reminder_anchor_id: 44, delivery_status: null },
    { id: 3, role: "assistant", content: "Cancelled RM388 graphic", pricing_reminder_anchor_id: 44, delivery_status: "cancelled" },
    { id: 4, role: "assistant", content: "Failed", delivery_status: "failed" },
    { id: 5, role: "assistant", content: "Unknown", delivery_status: "unknown" },
    { id: 6, role: "assistant", content: "Follow-up 3 testimonial", delivery_status: "delivered" },
    { id: 7, role: "assistant", content: "Actual price sent", pricing_reminder_anchor_id: 44, delivery_status: "sent" },
  ];
  messagesRepo.getMessagePageForContact = async () => ({ rows, hasMore: false });
  messagesRepo.getMessagesForContact = async () => rows;
  const expected = [
    { role:"user", content:"How much?" },
    { role:"assistant", content:"Follow-up 3 testimonial" },
    { role:"assistant", content:"Actual price sent" },
  ];
  assert.deepEqual(await conversationStore.getHistoryForContact(42,{throughMessageId:7}),expected);
  assert.deepEqual(await conversationStore.getHistoryForContact(42),expected);
});

test("AI history SQL excludes unsent pricing claims before loading the 20-message window", async(t)=>{
  const {pool}=require("../src/db/db");
  const original=pool.query;
  t.after(()=>{pool.query=original});
  let sql="";
  pool.query=async (query)=>{sql=query;return {rows:[]}};
  const messages=await messagesRepo.getMessagesForContact(42,20,false);
  assert.deepEqual(messages,[]);
  assert.match(sql,/NOT IN \('failed', 'unknown', 'cancelled'\)/);
  assert.match(sql,/pricing_reminder_anchor_id IS NOT NULL/);
  assert.match(sql,/delivery_status IS NULL OR delivery_status = 'cancelled'/);
});


test("pricing-only history reads up to 100 rows without changing the 20-turn model prompt", async (t) => {
  const original=messagesRepo.getMessagePageForContact;
  t.after(()=>{messagesRepo.getMessagePageForContact=original;});
  const stamp=new Date(Date.now()-60_000).toISOString();
  const rows=Array.from({length:27},(_,index)=>({
    id:index+1,role:index===0||index===26?"user":"assistant",
    content:index===0?"想了解骨盆调理":index===26?"多少钱？":"骨盆调理护理说明",
    created_at:new Date(Date.now()-(27-index)*30_000).toISOString(),
    sent_by_username:index===8?"WhatsApp Business App":null,
    is_automated_follow_up:false,
  }));
  let requestedLimit=0;
  messagesRepo.getMessagePageForContact=async(_contactId,options)=>{
    requestedLimit=options.limit;
    return {rows: options.limit===20?rows.slice(-20):rows,hasMore:false};
  };
  const ordinary=await conversationStore.getHistoryForContact(18,{throughMessageId:27});
  assert.equal(requestedLimit,20);
  assert.equal(ordinary.length,20);
  const pricing=await conversationStore.getPricingHistoryForContact(18,{throughMessageId:27});
  assert.equal(requestedLimit,100);
  assert.equal(pricing.length,27);
  assert.equal(pricing[0].content,"想了解骨盆调理");
  assert.equal(pricing[8].pricingStaffAuthored,true);
  assert.match(pricing[8].content,/^\[Verified STAFF message\]/u);
  assert.equal(Object.keys(pricing[8]).includes("pricingStaffAuthored"),false);
  assert.equal(pricing.at(-1).contextMessageId,27);
});

test("pricing history fails closed on a truncated seven-day window or mutated staff row", async (t) => {
  const original=messagesRepo.getMessagePageForContact;
  t.after(()=>{messagesRepo.getMessagePageForContact=original;});
  const nowIso=new Date().toISOString();
  const fresh=[
    {id:9,role:"user",content:"骨盆调理",created_at:nowIso},
    {id:10,role:"assistant",content:"骨盆调理护理说明",created_at:nowIso},
    {id:11,role:"user",content:"价钱",created_at:nowIso},
  ];
  messagesRepo.getMessagePageForContact=async()=>({rows:fresh,hasMore:true});
  assert.equal(await conversationStore.getPricingHistoryForContact(11,{throughMessageId:11}),null,
    "cannot infer that the earlier staff/topic messages were absent");
  messagesRepo.getMessagePageForContact=async()=>({
    rows:[fresh[0],{...fresh[1],whatsapp_customer_mutation:"edit"},fresh[2]],
    hasMore:false,
  });
  assert.equal(await conversationStore.getPricingHistoryForContact(11,{throughMessageId:11}),null);
  messagesRepo.getMessagePageForContact=async()=>({
    rows:[fresh[0],{...fresh[1],delivery_status:"failed"},fresh[2]],
    hasMore:false,
  });
  assert.equal(await conversationStore.getPricingHistoryForContact(11,{throughMessageId:11}),null);
  messagesRepo.getMessagePageForContact=async()=>({rows:fresh.slice(0,2),hasMore:false});
  assert.equal(await conversationStore.getPricingHistoryForContact(11,{throughMessageId:11}),null);
});

test("seven-day cut-off allows older historical pages without inheriting old staff", async (t) => {
  const original=messagesRepo.getMessagePageForContact;
  t.after(()=>{messagesRepo.getMessagePageForContact=original;});
  const old=new Date(Date.now()-9*24*60*60*1000).toISOString();
  const fresh=new Date(Date.now()-1000).toISOString();
  messagesRepo.getMessagePageForContact=async()=>({
    rows:[
      {id:1,role:"assistant",content:"staff replied",sent_by_username:"admin",created_at:old},
      {id:2,role:"user",content:"骨盆调理",created_at:fresh},
      {id:3,role:"assistant",content:"骨盆调理护理说明",created_at:fresh},
      {id:4,role:"user",content:"价钱",created_at:fresh},
    ],hasMore:true,
  });
  const history=await conversationStore.getPricingHistoryForContact(12,{throughMessageId:4});
  assert.equal(history.length,3);
  assert.equal(history[0].content,"骨盆调理");
});
