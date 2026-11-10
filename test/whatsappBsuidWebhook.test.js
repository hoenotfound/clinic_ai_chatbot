"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseIncomingMessages, parseBusinessAppEchoes } =
  require("../src/services/whatsappService");

function webhook(message, contacts=[]) {
  return { object:"whatsapp_business_account",entry:[{
    id:"1852014482431209",changes:[{field:"messages",value:{
      messaging_product:"whatsapp",
      metadata:{display_phone_number:"60174831336",phone_number_id:"1318355951360575"},
      contacts,messages:[message],
    }}],
  }] };
}
test("direct Cloud API: no phone, from_user_id + contacts[].profile.username",()=>{
  const id="MY.aBcD12345";
  const [incoming]=parseIncomingMessages(webhook({
    id:"wamid.bsuid-one",type:"text",from_user_id:id,
    text:{body:"Location?"},timestamp:"1794297720",
  },[{user_id:id,profile:{name:"Peggy",username:"Peggyteoh"}}]));
  assert.equal(incoming.from,id);
  assert.equal(incoming.customerUserId,id);
  assert.equal(incoming.customerUsername,"Peggyteoh");
  assert.equal(incoming.profileName,"Peggy");
  assert.equal(incoming.text,"Location?");
  assert.equal(incoming.businessPhoneNumberId,"1318355951360575");
  assert.equal(incoming.businessAccountId,"1852014482431209");
});
test("direct Cloud API: BSUID still routes when contacts[] is omitted",()=>{
  const id="MY.1234ABC";
  const [incoming]=parseIncomingMessages(webhook({
    id:"wamid.bsuid-no-from",type:"text",from_user_id:id,
    text:{body:"你好"},
  }));
  assert.equal(incoming.from,id);
  assert.equal(incoming.customerUserId,id);
});
test("phone-visible webhook preserves phone and separate from_user_id",()=>{
  const [incoming]=parseIncomingMessages(webhook({
    id:"wamid.phone-visible",type:"text",from:"60123456789",
    from_user_id:"MY.1234ABC",text:{body:"Hi"},
  },[{wa_id:"60123456789",user_id:"MY.1234ABC",
    profile:{name:"Guest",username:"hello_world"}}]));
  assert.equal(incoming.from,"60123456789");
  assert.equal(incoming.customerUserId,"MY.1234ABC");
  assert.equal(incoming.customerUsername,"hello_world");
  assert.equal(incoming.profileName,"Guest");
});
test("Coexistence: staff echo to_user_id with no to survives parsing",()=>{
  const id="MY.1234ABC";
  const payload={object:"whatsapp_business_account",entry:[{
    id:"1852014482431209",changes:[{
      field:"smb_message_echoes",value:{
        metadata:{phone_number_id:"1318355951360575"},
        message_echoes:[{
          id:"wamid.staff-echo",from:"60174831336",to_user_id:id,
          type:"text",text:{body:"Our location is PJ Section 19"},
        }],
      },
    }],
  }]};
  const [echo]=parseBusinessAppEchoes(payload);
  assert.equal(echo.to,id);
  assert.equal(echo.toUserId,id);
  assert.equal(echo.text,"Our location is PJ Section 19");
  assert.equal(echo.businessPhoneNumberId,"1318355951360575");
});
test("Coexistence: phone-present staff echo retains both identifiers",()=>{
  const id="MY.1234ABC";
  const payload={entry:[{id:"1852014482431209",changes:[{
    field:"smb_message_echoes",value:{metadata:{phone_number_id:"1318355951360575"},
      message_echoes:[{id:"wamid.staff-two",to:"60123456789",to_user_id:id,
        type:"text",text:{body:"Hi"}}]},
  }]}]};
  const [echo]=parseBusinessAppEchoes(payload);
  assert.equal(echo.to,"60123456789");
  assert.equal(echo.toUserId,id);
});
test("display username alone is never used as a routable ID",()=>{
  const originalWarn=console.warn;
  console.warn=()=>{};
  try{
    assert.equal(parseIncomingMessages(webhook({
      id:"wamid.username-only",type:"text",
      username:"@not_a_bsuid",text:{body:"Location?"}
    },[{profile:{username:"@not_a_bsuid"}}])).length,0);
  }finally{console.warn=originalWarn;}
});
