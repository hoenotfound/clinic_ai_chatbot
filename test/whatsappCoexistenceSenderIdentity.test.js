"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { verifiedPrimaryEchoIdentity } = require("../src/services/whatsappCoexistenceService");

test("Business App identity accepts exact numeric phone/account IDs", t => {
  const oldPhone=process.env.WHATSAPP_PHONE_NUMBER_ID, oldAccount=process.env.WHATSAPP_WABA_ID;
  process.env.WHATSAPP_PHONE_NUMBER_ID="1408739622311791";
  process.env.WHATSAPP_WABA_ID="200000000000001";
  t.after(()=>{
    if(oldPhone === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID=oldPhone;
    if(oldAccount === undefined) delete process.env.WHATSAPP_WABA_ID;
    else process.env.WHATSAPP_WABA_ID=oldAccount;
  });
  const echo={to:"60123001234",businessPhoneNumberId:"1408739622311791",
    businessAccountId:"200000000000001"};
  assert.deepEqual(verifiedPrimaryEchoIdentity(echo),
    {accountId:"200000000000001", phoneNumberId:"1408739622311791",customerPhone:"60123001234"});
  assert.throws(()=>verifiedPrimaryEchoIdentity({...echo,businessPhoneNumberId:"110552088553929"}), /not identify/);
  assert.throws(()=>verifiedPrimaryEchoIdentity({...echo,businessAccountId:"invalid"}), /not identify/);
});
