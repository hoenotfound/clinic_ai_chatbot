const test=require("node:test");
const assert=require("node:assert/strict");
const cache=require("../src/services/whatsappFreeEntryMediaCache");

test("cached Meta media ID expires and is segregated by WABA phone number and MIME",()=>{
  cache.clear();
  try{
    const now=Date.parse("2026-10-09T00:00:00Z");
    assert.equal(cache.put(21,"image/jpeg","12345",now,"phone-A"),true);
    assert.equal(cache.get(21,"image/jpeg",now+1000,"phone-A"),"12345");
    assert.equal(cache.get(21,"image/jpeg",now+1000,"phone-B"),null);
    assert.equal(cache.get(21,"image/png",now+1000,"phone-A"),null);
    assert.equal(cache.get(21,"image/jpeg",now+1000,"phone-A"),null,
      "MIME mismatch removes the stale entry");
    cache.put(22,"image/png","67890",now,"phone-A");
    assert.equal(cache.get(22,"image/png",now+cache.TTL_MS-1,"phone-A"),"67890");
    assert.equal(cache.get(22,"image/png",now+cache.TTL_MS,"phone-A"),null);
    assert.equal(cache.put(22,"image/jpeg","non-numeric",now,"phone-A"),false);
  } finally{cache.clear();}
});
test("reuse cache stays bounded and supports explicit invalidation",()=>{
  cache.clear();
  try{
    for(let i=1;i<=50;i++)cache.put(i,"image/jpeg",String(i),Date.now(),"phone-A");
    assert.equal(cache.get(1,"image/jpeg",Date.now(),"phone-A"),null);
    assert.equal(cache.get(50,"image/jpeg",Date.now(),"phone-A"),"50");
    cache.forget(50,"phone-A");
    assert.equal(cache.get(50,"image/jpeg",Date.now(),"phone-A"),null);
  } finally{cache.clear();}
});
