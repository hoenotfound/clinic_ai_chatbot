"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const express = require("express");
const { httpDatabaseActivitySource } = require("../src/utils/httpDatabaseActivitySource");
const { withDatabaseActivitySource, currentDatabaseActivitySource } =
  require("../src/utils/databaseActivityContext");
const { createPoolActivityTracker } = require("../src/services/databasePoolActivity");
const { summarizePoolActivity } = require("../src/services/memoryDiagnosticsService");

test("HTTP request attribution never includes patient paths, query values or tokens", () => {
  const rows = [
    ["/webhook", "HTTP WhatsApp ingress"],
    ["/whatsapp/default", "HTTP WhatsApp ingress"],
    ["/whatsapp/secondary-qa-capture", "HTTP WhatsApp ingress"],
    ["/meta-webhook", "HTTP Meta webhook"],
    ["/api/conversations", "HTTP Inbox list"],
    ["/api/conversations/9027", "HTTP Inbox detail"],
    ["/api/conversations/9027/messages/44", "HTTP Inbox detail"],
    ["/api/pipeline/9027", "HTTP pipeline API"],
    ["/api/config", "HTTP configuration API"],
    ["/api/auth/login", "HTTP auth API"],
    ["/api/contacts/9027", "HTTP other API"],
    ["/promo-images/12", "HTTP promo media"],
    ["/health/ready", "HTTP health"],
    ["/", "HTTP health"],
    ["/opaque/secret/9012", "HTTP other"],
  ];
  for (const [path, expected] of rows) {
    assert.equal(httpDatabaseActivitySource({path}), expected, path);
  }
  assert.equal(httpDatabaseActivitySource({path:null}), "HTTP other");
  assert.equal(httpDatabaseActivitySource({}), "HTTP other");
  assert.doesNotMatch(JSON.stringify(rows.map(([path]) =>
    httpDatabaseActivitySource({path}))), /9027|secret|patient|\/api\/conversations/);
});

test("passive Express request scope labels asynchronous pool acquisition and leaves responses untouched", async () => {
  const pool = new EventEmitter();
  pool.totalCount=0;pool.idleCount=0;pool.waitingCount=0;
  const tracker=createPoolActivityTracker(pool);
  const app=express();
  app.use((req, _res, next) =>
    withDatabaseActivitySource(httpDatabaseActivitySource(req), next));
  app.get("/api/conversations/:contactId", async (_req,res) => {
    await Promise.resolve();
    pool.emit("acquire");
    res.status(200).json({ ok: true });
  });
  const server=await new Promise(resolve => {
    const listener=app.listen(0,"127.0.0.1",()=>resolve(listener));
  });
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/conversations/9027`);
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{ok:true});
    assert.equal(currentDatabaseActivitySource(),"unattributed");
    const telemetry=summarizePoolActivity(tracker.snapshot());
    assert.equal(telemetry.acquiredTotal,1);
    assert.equal(telemetry.bySource[0].source,"HTTP Inbox detail");
    assert.doesNotMatch(JSON.stringify(telemetry),/9027/);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test("nested actual worker scope overrides request label instead of misattributing jobs", async () => {
  await withDatabaseActivitySource("HTTP WhatsApp ingress",async()=>{
    assert.equal(currentDatabaseActivitySource(),"HTTP WhatsApp ingress");
    await withDatabaseActivitySource("Secondary WhatsApp marketing followup scheduler",async()=>{
      await Promise.resolve();
      assert.equal(currentDatabaseActivitySource(),"Secondary WhatsApp marketing followup scheduler");
    });
    assert.equal(currentDatabaseActivitySource(),"HTTP WhatsApp ingress");
  });
});
