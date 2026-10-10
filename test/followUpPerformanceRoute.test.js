const test=require("node:test");
const assert=require("node:assert/strict");
const express=require("express");
const { pool }=require("../src/db/db");
const route=require("../src/routes/followUpPerformance");

test("Phase 7 HTTP endpoint enforces Tools access, assigned contacts and read-only SQL",async()=>{
  const old=pool.query;
  const calls=[];
  let user={username:"sales",role:"sales",permissions:{
    manage_tools:false,view_all_leads:false,view_assigned_leads:true,
  }};
  const app=express();
  app.use((req,_res,next)=>{req.user=user;next();});
  app.use("/api/follow-up-performance",route);
  const server=await new Promise(resolve=>{
    const listener=app.listen(0,"127.0.0.1",()=>resolve(listener));
  });
  const url="http://127.0.0.1:"+server.address().port+"/api/follow-up-performance";
  pool.query=async(sql,params)=>{
    calls.push({sql,params});
    if(sql.includes("WITH current_lead"))return {rows:[{contact_id:12}]};
    if(sql.includes("WITH eligible AS"))return {rows:[{summary:{
      sent:2,contacts:1,reply_matured:1,replied_matured:1,
    },breakdown:[],daily:[]}]};
    throw new Error("Unexpected SQL");
  };
  try{
    let res=await fetch(url);
    assert.equal(res.status,403);
    assert.equal(calls.length,0);
    user={...user,permissions:{...user.permissions,manage_tools:true}};
    res=await fetch(url+"?days=31");
    assert.equal(res.status,400);
    assert.equal(calls.length,0);
    res=await fetch(url+"?days=7&channel=facebook");
    assert.equal(res.status,200);
    assert.equal(res.headers.get("cache-control"),"no-store");
    const data=await res.json();
    assert.equal(data.summary.sent,2);
    assert.equal(data.filters.channel,"facebook");
    assert.equal(calls.length,2);
    assert.deepEqual(calls[1].params.slice(0,3),[7,"facebook",[12]]);
    assert.ok(calls.every(x=>/^\s*(WITH|SELECT)\b/i.test(x.sql)));
    user={...user,permissions:{manage_tools:true,view_all_leads:false,view_assigned_leads:false}};
    const before=calls.length;
    res=await fetch(url);
    assert.equal(res.status,200);
    const denied=await res.json();
    assert.equal(denied.summary.sent,0);
    assert.equal(calls.length,before);
  }finally{
    pool.query=old;
    await new Promise(resolve=>server.close(resolve));
  }
});
