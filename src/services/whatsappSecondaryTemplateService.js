"use strict";

// The secondary template catalog has NO shared primary cache. All live
// validation uses the secondary sender's exact WABA and token, with nonbillable/billable
// warnings sourced independently from legacy Neutro billing.
const { pool } = require("../db/db");
const policy = require("./whatsappSecondaryPolicyService");
const helpers = require("./whatsappTemplateService");
const reviewTokens = require("./whatsappTemplateBillingAdvisory");
const { sendSecondaryStaffText } = require("./whatsappSecondaryStaffDispatch");

const GRAPH_VERSION="v26.0";
function denied(code) { return { success:false,code,templates:[],error:"Secondary WhatsApp template authorization is unavailable." }; }
function clean(v) {return typeof v==="string"?v.trim():"";}
function configured(env) {
  return env.WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED==="true" &&
    env.WHATSAPP_SECONDARY_STAFF_SEND_ENABLED==="true" &&
    env.WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED==="true" &&
    env.WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED==="true" &&
    env.WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED==="true" &&
    env.WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED==="true" &&
    /^[0-9]+$/.test(clean(env.WHATSAPP_SECONDARY_WABA_ID)) &&
    clean(env.WHATSAPP_SECONDARY_TOKEN);
}
async function listSecondaryApprovedTemplates(contact,{
  env=process.env,database=pool,fetchImpl=global.fetch,
  staffUsername=null,now=new Date(),
}={}) {
  if (!configured(env)) return denied("secondary_template_disabled");
  const owner=await policy.secondaryPolicySnapshot(contact,{database,env});
  if (!owner.row || typeof fetchImpl!=="function") {
    return denied("secondary_template_sender_unverified");
  }
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  try {
    const url=new URL("https://graph.facebook.com/"+GRAPH_VERSION+"/"+
      env.WHATSAPP_SECONDARY_WABA_ID+"/message_templates");
    url.searchParams.set("fields","id,name,language,status,category,components");
    url.searchParams.set("limit","100");
    const response=await fetchImpl(url.toString(),{
      headers:{Authorization:"Bearer "+env.WHATSAPP_SECONDARY_TOKEN},
      signal:controller.signal,
    });
    if (!response.ok) return denied("secondary_template_catalog_unavailable");
    const body=await response.json();
    if (!Array.isArray(body?.data) || body.paging?.next) {
      // Incomplete catalog is not a safe basis for approval.
      return denied("secondary_template_catalog_incomplete");
    }
    const eligible=body.data.filter(t=>t?.status==="APPROVED" &&
      ["UTILITY","MARKETING"].includes(t?.category) &&
      /^[a-z0-9_]+$/.test(clean(t?.name)) &&
      /^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(clean(t?.language)))
      .map(helpers.normalizeTemplate).map(t=>({
        ...t,sendable:t.sendable &&
          (env.WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED === "true" ||
           !["IMAGE","VIDEO"].includes(t.header?.format)),
        unsupportedReason:["IMAGE","VIDEO"].includes(t.header?.format) &&
          env.WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED !== "true"
          ? "Secondary template media header sending is disabled."
          : t.unsupportedReason,
      }));
    const opted=Boolean(owner.row.whatsapp_opt_in_at && owner.row.whatsapp_opt_in_source &&
      !owner.row.whatsapp_opt_out_at);
    const safeTemplates=eligible.map(t=>({...t,sendable:t.sendable && opted}));
    let tokens={};
    if (clean(staffUsername)) {
      tokens=Object.fromEntries(safeTemplates.filter(t=>t.sendable).map(t=>[
        t.name+"::"+t.language,
        reviewTokens.issueReviewToken(contact.id,staffUsername,"unknown",{
          env,now,templateName:t.name,languageCode:t.language,
        }),
      ]));
    }
    return {
      success:true,templates:safeTemplates,
      reusableMedia:[],
      cached:false,
      billingAdvisory:{
        evidence:"unknown",reviewedAt:new Date(now).toISOString(),
        freeEntry:{verified:false,sendReady:false,blockedReason:null},
        reviewTokens:tokens,
      },
      eligibility:{
        allowed:opted,code:opted?null:"secondary_missing_opt_in",
        message:opted?null:"Confirm WhatsApp opt-in for this receiving number.",
        optInAt:owner.row.whatsapp_opt_in_at,
        marketingOptOutAt:owner.row.whatsapp_marketing_opt_out_at,
      },
    };
  } catch {
    return denied("secondary_template_catalog_unavailable");
  } finally {
    clearTimeout(timer);
  }
}

async function prepareSecondaryStaffTemplate(contact,{
  name,languageCode,values,billingAcknowledged=false,mediaAttachment=null,
  marketingConsentConfirmed=false,
},{
  env=process.env,database=pool,fetchImpl=global.fetch,
}={}) {
  if(!configured(env)||billingAcknowledged!==true) return denied("secondary_template_billing_ack_required");
  if (!/^[a-z0-9_]+$/.test(clean(name)) ||
      !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(clean(languageCode))) {
    return denied("secondary_template_invalid");
  }
  const approved=await policy.previewSecondaryTemplatePolicy(contact,{
    name,languageCode,env,database,fetchImpl,
  });
  if(approved.policyAllowed!==true || !approved.template?.definition) {
    return denied(approved.code||"secondary_template_policy_blocked");
  }
  if(approved.template.category==="MARKETING" && marketingConsentConfirmed!==true) {
    return denied("secondary_marketing_confirmation_required");
  }
  const template=helpers.normalizeTemplate(approved.template.definition);
  const mediaFormat=template.header?.format;
  const needsMedia=["IMAGE","VIDEO"].includes(mediaFormat);
  if (!template.sendable || (needsMedia &&
      env.WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED!=="true")) {
    return denied("secondary_template_media_not_enabled");
  }
  if (needsMedia) {
    const expected=mediaFormat==="IMAGE" ?
      new Set(["image/jpeg","image/png"]) : new Set(["video/mp4"]);
    if(!mediaAttachment || !Buffer.isBuffer(mediaAttachment.buffer) ||
        mediaAttachment.buffer.length<1 ||
        mediaAttachment.buffer.length>(mediaFormat==="IMAGE"?5:16)*1024*1024 ||
        !expected.has(mediaAttachment.mimeType) ||
        typeof mediaAttachment.filename!=="string" ||
        !/^[A-Za-z0-9._ -]{1,180}$/.test(mediaAttachment.filename)) {
      return denied("secondary_template_media_invalid");
    }
  } else if(mediaAttachment) {
    return denied("secondary_template_media_not_allowed");
  }
  const built=helpers.buildTemplateComponents(template,values,
    {allowMissingMedia:needsMedia});
  if(!built.valid) return denied("secondary_template_invalid_values");
  const preview=helpers.renderTemplatePreview(template,built.values);
  if(!preview)return denied("secondary_template_preview_unavailable");
  return {
    success:true,preview,components:built.components,template,
    values:built.values,mediaAttachment,
    signature:helpers.templateSignature(template),
  };
}
async function deliverSecondaryStaffTemplate(contact,messageId,prepared,{
  env=process.env,database=pool,
  sendText=sendSecondaryStaffText,fetchImpl=global.fetch,
}={}) {
  if(!prepared?.success || !prepared.template || !prepared.signature ||
      !Array.isArray(prepared.components)) return denied("secondary_template_unverified");
  const template=prepared.template;
  return sendText({
    contact,messageId,origin:"staff",
    text:"[staff-approved-template]",
    templateRequest:{
      name:template.name,languageCode:template.language,
      expectedSignature:prepared.signature,billingConfirmed:true,
    },
    dispatchTransport:async transport=>{
      let components=prepared.components;
      if(prepared.mediaAttachment) {
        const item=prepared.mediaAttachment;
        const uploaded=await transport.uploadMedia(
          item.buffer,item.mimeType,item.filename
        );
        if(!uploaded?.success || !/^[0-9]+$/.test(String(uploaded.mediaId||""))) {
          return {success:false,unknown:true,ambiguous:true,retryable:false};
        }
        // A template can be paused, revoked or newly opted-out while uploading
        // media. Recheck the exact signed sender + approval and consent.
        const verified=await policy.previewSecondaryTemplatePolicy(contact,{
          name:template.name,languageCode:template.language,
          env,database,fetchImpl,now:new Date(),
        });
        if(verified.policyAllowed!==true ||
            !verified.template?.definition ||
            helpers.templateSignature(helpers.normalizeTemplate(verified.template.definition))
              !==prepared.signature) {
          return {success:false,unknown:true,ambiguous:true,retryable:false};
        }
        const built=helpers.buildTemplateComponents(template,prepared.values,{
          media:{id:uploaded.mediaId},
        });
        if(!built.valid)return {success:false,unknown:true,ambiguous:true,retryable:false};
        components=built.components;
      }
      return transport.sendTemplatePayload(template.name,template.language,components);
    },
  },{env,database,fetchImpl});
}
module.exports={
  listSecondaryApprovedTemplates,
  prepareSecondaryStaffTemplate,
  deliverSecondaryStaffTemplate,
};
