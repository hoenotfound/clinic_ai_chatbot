"use strict";

// Ariel-only staff media. No legacy provider fallback, media-ID cache sharing,
// automatic retry, or template policy override.
const { pool } = require("../db/db");
const mediaStorage = require("./mediaStorageService");
const contactsRepo = require("../db/contactsRepo");
const secondaryPolicy = require("./whatsappSecondaryPolicyService");
const { sendSecondaryStaffText } = require("./whatsappSecondaryStaffDispatch");

const LIMIT_BYTES = 16 * 1024 * 1024;
const MIME = Object.freeze({
  image: new Set(["image/jpeg", "image/png"]),
  video: new Set(["video/mp4", "video/3gpp"]),
  audio: new Set(["audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac"]),
  document: new Set([
    "application/pdf", "text/plain", "text/csv",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ]),
  sticker: new Set(["image/webp"]),
});
function deny(code) {
  return { success:false, wamid:null, retryable:false, policyBlocked:true,
    code, error:"This WhatsApp media send requires verified sender-specific staff access." };
}
function validText(v,limit=1024) {
  return typeof v==="string" && v.length<=limit &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v);
}
function allowedMediaBuffer(type,buffer,mime,filename) {
  return MIME[type]?.has(mime) && Buffer.isBuffer(buffer) &&
    buffer.length>0 && buffer.length<=LIMIT_BYTES &&
    typeof filename==="string" && filename.length>=1 &&
    filename.length<=255 && !/[\\/\x00-\x1f]/.test(filename);
}

// Direct media work is allowed only for an authenticated staff route with a
// server-persisted outbound row, not for AI, queued followups or non-staff callers.
async function sendSecondaryStaffMedia(contact, method, args, {
  env=process.env, database=pool,
  storage=mediaStorage, contacts=contactsRepo,
  policyService=secondaryPolicy,
  textDispatcher=sendSecondaryStaffText,
}={}) {
  if (env.WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED!=="true" ||
      env.WHATSAPP_SECONDARY_STAFF_SEND_ENABLED!=="true" ||
      contact?.channel!=="whatsapp" ||
      !contact?.whatsapp_sender_id ||
      contact.whatsapp_sender_key!==env.WHATSAPP_SECONDARY_SENDER_KEY ||
      !Array.isArray(args)) return deny("secondary_staff_media_disabled");

  const last=args[args.length-1];
  const options=last && typeof last==="object" && !Buffer.isBuffer(last) ? last : {};
  const messageId=Number(options.currentMessageId);
  if (options.staffMedia!==true || options.autoFollowUp===true ||
      !Number.isSafeInteger(messageId) || messageId<=0) {
    return deny("secondary_staff_media_unowned_message");
  }

  const allowedMethods=new Set([
    "sendImageByUrl", "sendImageBuffer", "sendVideoByStoredKey",
    "sendAudioBuffer", "sendDocumentBuffer", "sendStickerBuffer",
  ]);
  if (!allowedMethods.has(method)) return deny("secondary_staff_media_unsupported");

  let payload;
  if (method==="sendImageByUrl") {
    const [url,caption]=args;
    if (typeof url!=="string" || !/^https:\/\//.test(url) ||
        !validText(caption||"")) return deny("secondary_staff_media_invalid");
    payload={type:"image-url",url,caption:caption||""};
  } else if (method==="sendVideoByStoredKey") {
    const [key,caption,filename]=args;
    if (typeof key!=="string" || !key || !validText(caption||"") ||
        (filename!=null && !validText(filename,255))) {
      return deny("secondary_staff_media_invalid");
    }
    payload={type:"video-key",key,caption:caption||"",
      filename:filename||"video.mp4",
      mimeType:options.videoMimeType||"video/mp4"};
    if (!allowedMediaBuffer("video",Buffer.from("x"),payload.mimeType,payload.filename)) {
      return deny("secondary_staff_media_invalid");
    }
  } else {
    const [buffer,mimeType,third,fourth,fifth]=args;
    let type,caption,filename;
    if (method==="sendImageBuffer") {
      type="image";caption=third||"";filename=fourth||"image.jpg";
    } else if (method==="sendAudioBuffer") {
      type="audio";caption="";filename=third||"voice.ogg";
    } else if (method==="sendStickerBuffer") {
      type="sticker";caption="";filename=third||"sticker.webp";
    } else {
      type="document";filename=third||"document";caption=fourth||"";
    }
    if (!allowedMediaBuffer(type,buffer,mimeType,filename) ||
        !validText(caption)) return deny("secondary_staff_media_invalid");
    payload={type,buffer,mimeType,filename,caption};
  }

  const preSendCheck=async()=>{
    if (!contact.id) return false;
    // Staff takeover can change during an expensive video download/upload.
    const latest=await contacts.getContactById(contact.id);
    if (!latest || latest.mode!=="human" ||
        String(latest.whatsapp_sender_id)!==String(contact.whatsapp_sender_id) ||
        latest.whatsapp_sender_key!==env.WHATSAPP_SECONDARY_SENDER_KEY ||
        latest.whatsapp_number!==contact.whatsapp_number) return false;
    const fresh=await policyService.previewSecondaryFreeformPolicy(latest,{
      database,env,now:new Date(),purpose:"service",
    });
    return fresh?.policyAllowed===true;
  };

  return textDispatcher({
    contact,messageId,origin:"staff",
    text:"[staff media]",
    preSendCheck,
    dispatchTransport: async(transport)=>{
      let item=payload;
      if (item.type==="video-key") {
        let bytes;
        try {
          bytes=await storage.downloadMedia(item.key,{maxBytes:LIMIT_BYTES});
        } catch {
          return {success:false,ambiguous:true,retryable:false};
        }
        if (!allowedMediaBuffer("video",bytes,item.mimeType,item.filename)) {
          return {success:false,ambiguous:true,retryable:false};
        }
        item={...item,type:"video",buffer:bytes};
      }
      if (item.type==="image-url") {
        if (!(await preSendCheck())) {
          return {success:false,ambiguous:true,retryable:false};
        }
        return transport.sendImageByUrl(item.url,item.caption);
      }
      const uploaded=await transport.uploadMedia(item.buffer,item.mimeType,item.filename);
      // An unverified upload result can never create a new provider send.
      if (!uploaded?.success || !uploaded.mediaId) {
        return {success:false,ambiguous:true,retryable:false};
      }
      if (!(await preSendCheck())) {
        return {success:false,ambiguous:true,retryable:false};
      }
      return transport.sendMediaById(item.type,item.mediaId||uploaded.mediaId,{
        caption:item.caption||"",filename:item.filename,
        voice:item.type==="audio",
      });
    },
  },{ env,database });
}

module.exports={sendSecondaryStaffMedia,allowedMediaBuffer};
