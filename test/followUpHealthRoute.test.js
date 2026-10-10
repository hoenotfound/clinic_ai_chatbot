const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { pool } = require("../src/db/db");
const clinicConfig = require("../src/config/clinicConfig");
const route = require("../src/routes/followUpHealth");

test("Phase 6 HTTP endpoint enforces Tools permissions, assigned lead scope, input bounds and no writes", async () => {
  const originalQuery = pool.query;
  const previousSettings = clinicConfig.automatedFollowUp;
  const queries = [];
  let user = { username:"sales", role:"sales", permissions:{manage_tools:false,
    view_all_leads:false,view_assigned_leads:true} };
  const app = express();
  app.use((req,_res,next)=>{req.user=user;next();});
  app.use("/api/follow-up-health",route);
  const server = await new Promise(resolve=>{
    const s=app.listen(0,"127.0.0.1",()=>resolve(s));
  });
  const url="http://127.0.0.1:"+server.address().port;
  clinicConfig.automatedFollowUp = { enabled:true, triggerMode:"all",
    activatedAt:"2026-10-01T00:00:00Z",delayMinutes:120,additionalSteps:[],
    quietHours:{enabled:false,start:"00:00",end:"07:00"} };
  pool.query=async (sql,params)=>{
    queries.push({sql,params});
    if(sql.includes("WITH current_lead"))return {rows:[{contact_id:27}]};
    if(sql.includes("WITH evidence AS"))return {rows:[{
      breakdown:[{channel:"facebook",type:"follow_up",part:"message",step:1,
        service:"3D",status:"failed",count:1}],
      alerts:[{id:"message:222",contact_id:27,channel:"facebook",status:"failed"}],
      failed_count:1,attention_count:0,stale_pending_count:0,event_count:1,
    }]};
    if(sql.includes("WITH recently_active"))return {rows:[{due_now:0,upcoming:[]}]};
    throw new Error("Unexpected query");
  };
  try{
    let res=await fetch(url);
    assert.equal(res.status,403);
    assert.equal(queries.length,0);
    user={...user,permissions:{manage_tools:true,view_all_leads:false,view_assigned_leads:true}};
    res=await fetch(url+"?days=180");
    assert.equal(res.status,400);
    assert.equal(queries.length,0);
    res=await fetch(url+"?days=7&channel=facebook");
    assert.equal(res.status,200);
    const body=await res.json();
    assert.equal(body.failedCount,1);
    assert.equal(body.dueNowCount,0);
    assert.equal(body.alerts[0].contact_id,27);
    assert.equal(queries.length,3);
    assert.deepEqual(queries[1].params[2],[27]);
    assert.deepEqual(queries[2].params[1],[27]);
    assert.ok(queries.every(x=>/^\s*(SELECT|WITH)\b/i.test(x.sql)),"no write SQL");
    user={...user,permissions:{manage_tools:true,view_all_leads:false,view_assigned_leads:false}};
    const previous=queries.length;
    res=await fetch(url);
    assert.equal(res.status,200);
    assert.deepEqual((await res.json()).upcoming,[]);
    assert.equal(queries.length,previous);
  }finally{
    pool.query=originalQuery;
    clinicConfig.automatedFollowUp=previousSettings;
    await new Promise(resolve=>server.close(resolve));
  }
});
