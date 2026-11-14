"use strict";
if(process.env.NEUTRO_PULSE_RECOVERY_SEND_ENABLED==="true"){
  const job=require("./neutroPulseVideoRecoverySend");
  if(job.enabled(process.env)){
    const timer=setTimeout(()=>{
      job.run().then(result=>{
        // Never log customer phone numbers, text, media bytes or auth tokens.
        console.log("[Neutro Pulse recovery] "+JSON.stringify(result));
      }).catch(err=>{
        console.error("[Neutro Pulse recovery] FAILURE "+String(err?.code||err?.name||"unknown"));
      });
    },18000);
    timer.unref?.();
  }
}