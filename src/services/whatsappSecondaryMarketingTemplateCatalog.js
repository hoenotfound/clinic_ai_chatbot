"use strict";
const helpers=require("./whatsappTemplateService");
const {approvedStaticMarketingTemplate}=require("./whatsappSecondaryMarketingFollowUpService");
const GRAPH_VERSION="v26.0";
async function listApprovedSecondaryMarketingTemplates({
 env=process.env,fetchImpl=global.fetch,
}={}){
 if(!/^[0-9]+$/.test(String(env.WHATSAPP_SECONDARY_WABA_ID||"")) ||
    !String(env.WHATSAPP_SECONDARY_TOKEN||"").trim() ||
    typeof fetchImpl!=="function")return [];
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),10000);
 try{
  const url=new URL("https://graph.facebook.com/"+GRAPH_VERSION+"/"+
    env.WHATSAPP_SECONDARY_WABA_ID+"/message_templates");
  url.searchParams.set("fields","id,name,language,status,category,components");
  url.searchParams.set("limit","100");
  const response=await fetchImpl(url.toString(),{
   headers:{Authorization:"Bearer "+env.WHATSAPP_SECONDARY_TOKEN},
   signal:controller.signal,
  });
  if(!response.ok)throw Error("Secondary template catalog unavailable");
  const data=await response.json();
  if(!Array.isArray(data.data) || data.paging?.next)
   throw Error("Incomplete second-number template catalog");
  return data.data.map(item=>{
   const normalized=helpers.normalizeTemplate(item);
   const signature=helpers.templateSignature(normalized);
   return approvedStaticMarketingTemplate(item,signature) ?
    {name:normalized.name,languageCode:normalized.language,
     signature,body:normalized.body.text} : null;
  }).filter(Boolean);
 }finally{clearTimeout(timer);}
}
module.exports={listApprovedSecondaryMarketingTemplates};
