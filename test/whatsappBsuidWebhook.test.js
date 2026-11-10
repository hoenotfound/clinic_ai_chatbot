"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseIncomingMessages } = require("../src/services/whatsappService");

function webhook(message, contacts=[]) {
  return { object:"whatsapp_business_account",entry:[{
    id:"1852014482431209",changes:[{field:"messages",value:{
      metadata:{phone_number_id:"1318355951360575"},contacts,messages:[message],
    }}],
  }] };
}
test("phone-hidden username message keeps the exact signed BSUID and treatment text",()=>{
  const id="MY.aBcD12345";
  const [incoming]=parseIncomingMessages(webhook({
    id:"wamid.bsuid-one",type:"text",from:id,user_id:id,
    username:"@Peggyteoh",text:{body:"Location?"},timestamp:"1794297720",
  }));
  assert.equal(incoming.from,id);
  assert.equal(incoming.customerUserId,id);
  assert.equal(incoming.customerUsername,"@Peggyteoh");
  assert.equal(incoming.text,"Location?");
  assert.equal(incoming.businessPhoneNumberId,"1318355951360575");
  assert.equal(incoming.businessAccountId,"1852014482431209");
});
test("Meta user_id can address phone-hidden message even if from is absent",()=>{
  const id="MY.1234ABC";
  const [incoming]=parseIncomingMessages(webhook({
    id:"wamid.bsuid-no-from",type:"text",user_id:id,
    text:{body:"你好"},
  }));
  assert.equal(incoming.from,id);
  assert.equal(incoming.customerUserId,id);
});
test("phone-visible webhook preserves phone plus independently supplied BSUID",()=>{
  const [incoming]=parseIncomingMessages(webhook({
    id:"wamid.phone-visible",type:"text",from:"60123456789",
    user_id:"MY.1234ABC",text:{body:"Hi"},
  },[{wa_id:"60123456789",profile:{name:"Guest"}}]));
  assert.equal(incoming.from,"60123456789");
  assert.equal(incoming.customerUserId,"MY.1234ABC");
  assert.equal(incoming.profileName,"Guest");
});
