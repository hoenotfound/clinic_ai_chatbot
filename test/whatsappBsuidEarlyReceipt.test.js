"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const {applyStagedSecondaryReceipts}=
  require("../src/db/whatsappSenderEarlyReceiptRepo");
const sha=value=>crypto.createHash("sha256").update(value).digest("hex");
const env={WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575",
  WHATSAPP_SECONDARY_WABA_ID:"1852014482431209",
  WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true"};
const reservationId="11111111-1111-4111-8111-111111111111";
const args={senderId:2,contactId:17,messageId:76,reservationId,
  acceptedWamid:"wamid.accepted-one",env};

function db({savedRecipient="MY.Verified42",alternate="MY.Verified42"}={}){
  const calls=[];
  return {calls,client:{query:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.includes("FROM contacts c JOIN whatsapp_sender_billing_attempts"))
      return {rowCount:1,rows:[{whatsapp_number:"60123456789",
        whatsapp_user_id:"MY.Verified42",recipient_address:savedRecipient}]};
    if(sql.startsWith("SELECT 1 FROM whatsapp_sender_billing_attempts"))
      return {rowCount:0,rows:[]};
    if(sql.includes("FROM whatsapp_sender_status_receipts")&&sql.includes("ORDER BY received_at"))
      return {rowCount:1,rows:[{fingerprint:"f".repeat(64),
        recipient_hash:sha("60123456789"),alternate_recipient_hash:sha(alternate),
        delivery_status:"delivered",pricing_type:null,pricing_billable:null,
        pricing_category:null}]};
    if(sql.startsWith("UPDATE whatsapp_sender_status_receipts")) {
      assert.match(sql,/alternate_recipient_hash=\$5/);
      return {rowCount:1,rows:[{fingerprint:"f".repeat(64)}]};
    }
    if(sql.startsWith("UPDATE messages"))
      return {rowCount:1,rows:[{id:76}]};
    if(sql.includes("SELECT billable_authorized,billing_authorization_source"))
      return {rowCount:1,rows:[{billable_authorized:false,billing_authorization_source:null}]};
    throw Error("Unexpected SQL in early receipt test: "+sql.slice(0,100));
  }}};
}
test("early paired phone/BSUID receipt matches the sent BSUID after contact switches to phone",async()=>{
  const {client,calls}=db();
  const result=await applyStagedSecondaryReceipts({client,...args});
  assert.equal(result.matched,1);
  assert.equal(result.autoReconciled,false,"no pricing evidence cannot release billing");
  assert.equal(calls.filter(x=>x.sql.startsWith("UPDATE whatsapp_sender_status_receipts")).length,1);
  assert.equal(calls.find(x=>x.sql.startsWith("UPDATE whatsapp_sender_status_receipts")).params[4],
    sha("MY.Verified42"));
});
test("unrelated paired recipient IDs never get matched to a frozen attempt",async()=>{
  const {client,calls}=db({savedRecipient:"MY.OtherUser",alternate:"MY.Verified42"});
  await assert.rejects(
    applyStagedSecondaryReceipts({client,...args}),
    /Early receipt owner cannot be verified/,
    "an unrelated recipient must fail closed before any update");
  assert.equal(calls.some(x=>x.sql.startsWith("UPDATE whatsapp_sender_status_receipts")),false);
});
