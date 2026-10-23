"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { stagingAccessGuard } = require("../src/middleware/pr395StagingBasicAuth");

const env = {
  PR395_STAGING_BASIC_AUTH_ENABLED: "true",
  PR395_STAGING_BASIC_AUTH_USERNAME: "qa-admin",
  PR395_STAGING_BASIC_AUTH_PASSWORD: "long-random-secret-more-than-thirty-two-characters",
};

function call(path, auth = null, overrides = {}) {
  const state = { status: null, headers: {}, body: null, next: false };
  const req = { path, get(name) {
    return name.toLowerCase() === "authorization" ? auth : null;
  }};
  const res = {
    set(k,v){state.headers[k] = v;return this;},
    status(n){state.status = n;return this;},
    send(body){state.body = body;return this;},
  };
  stagingAccessGuard(req,res,()=>{state.next=true}, {...env,...overrides});
  return state;
}
test("PR395 staging requires strong credentials for portal and API",()=>{
  for (const route of ["/api/conversations","/api/auth/login","/setup-status","/"]) {
    const result=call(route);
    if(route === "/") assert.equal(result.next,true);
    else {
      assert.equal(result.status,401);
      assert.equal(result.next,false);
      assert.match(result.headers["WWW-Authenticate"], /Basic/);
      assert.equal(result.headers["Cache-Control"],"no-store");
    }
  }
});
test("staging rejects wrong Basic auth and allows matching credentials",()=>{
  const wrong="Basic "+Buffer.from("qa-admin:wrong").toString("base64");
  assert.equal(call("/api/conversations",wrong).status,401);
  const correct="Basic "+Buffer.from(env.PR395_STAGING_BASIC_AUTH_USERNAME+":"+env.PR395_STAGING_BASIC_AUTH_PASSWORD).toString("base64");
  assert.equal(call("/api/conversations",correct).next,true);
  assert.equal(call("/health/ready").next,true);
  assert.equal(call("/webhook").next,true);
  assert.equal(call("/meta-webhook").next,true);
});
test("staging fails closed when password is missing or weak; production is unchanged",()=>{
  assert.equal(call("/api/auth/login",null,{PR395_STAGING_BASIC_AUTH_PASSWORD:"bad"}).status,503);
  assert.equal(call("/api/auth/login",null,{PR395_STAGING_BASIC_AUTH_ENABLED:"false"}).next,true);
});
