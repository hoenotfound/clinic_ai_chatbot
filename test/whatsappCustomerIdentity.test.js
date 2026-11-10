"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isBsuid, normalizeCustomerAddress, normaliseUserId,
  whatsappRecipientFields, inboundIdentityKind,
} = require("../src/utils/whatsappCustomerIdentity");

test("BSUID is preserved verbatim; it is not a telephone or a display username",()=>{
  const id="MY.12AbCd902";
  assert.equal(isBsuid(id),true);
  assert.equal(normalizeCustomerAddress(id),id);
  assert.equal(normaliseUserId(id),id);
  assert.equal(inboundIdentityKind(id),"bsuid");
  assert.deepEqual(whatsappRecipientFields(id),{recipient:id});
  for(const invalid of ["@Peggyteoh","MY.", "MY.abc-123",
    "whatsapp:MY.12ABC","my.12ABC","__proto__", "MY."+"A".repeat(129)]) {
    assert.equal(isBsuid(invalid),false);
    assert.equal(normaliseUserId(invalid),null);
  }
});
test("ordinary Malaysian numbers still use the existing Cloud API to field",()=>{
  assert.equal(normalizeCustomerAddress("+60 12-345 6789"),"60123456789");
  assert.equal(normalizeCustomerAddress("012-3456789"),"60123456789");
  assert.deepEqual(whatsappRecipientFields("60123456789"),{to:"60123456789"});
  assert.equal(inboundIdentityKind("60123456789"),"phone");
});
test("reject unrecognized identifiers instead of silently inventing numbers",()=>{
  for(const bad of ["",null,"@Peggyteoh","GB.a_b", "abc123","1".repeat(20)]) {
    assert.equal(normalizeCustomerAddress(bad),null);
  }
  assert.throws(()=>whatsappRecipientFields("@Peggyteoh"),/Invalid/);
});
