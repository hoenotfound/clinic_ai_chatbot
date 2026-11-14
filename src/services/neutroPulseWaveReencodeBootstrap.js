"use strict";
if(process.env.NEUTRO_PULSE_REENCODE_ENABLED==="true"){
  const job=require("./neutroPulseWaveReencodeJob");
  if(job.enabled(process.env)){
    const timer=setTimeout(()=>{
      job.run().then(result=>{
        console.log("[Neutro Pulse reencode] "+
          JSON.stringify(result));
      }).catch(error=>{
        // Do not halt production traffic or print customer video contents.
        console.error("[Neutro Pulse reencode] FAILED: "+
          String(error?.message||error).slice(0,320));
      });
    },15000);
    timer.unref?.();
  }
}
