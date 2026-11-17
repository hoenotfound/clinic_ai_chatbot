"use strict";
// Settings-managed clinic media uses two distinct access policies.
// Before/After results are PRIVATE; never expose their HTTP preview URL to
// Meta or another user. Load bytes server-side and upload with the verified
// secondary WABA token at the last outbound transport boundary.
const promoImages=require("../db/promoImagesRepo");
const MAX_IMAGE_BYTES=5*1024*1024;
// These are Neutro's exact operator-controlled public image origins, not
// general domains or domains derived from an incoming request.
const OWNED_PROMO_ORIGINS=new Set([
 "https://da-chatbot-neutro-sense-tcm.onrender.com",
 "https://neutrosense.dasmarketingsolution.com",
]);
function ownedImagePath(value,env=process.env){
 if(typeof value!=="string" || value.length>255)return null;
 if(value.startsWith("/"))return value;
 let parsed;
 try{parsed=new URL(value);}catch{return null;}
 if(parsed.protocol!=="https:" || parsed.username || parsed.password ||
    parsed.search || parsed.hash || parsed.href!==value)return null;
 // Only public Settings promotions may be trusted as absolute URLs.
 // Private Before/After previews remain relative and never go to Meta by URL.
 if(!/^\\/promo-images\\/[1-9][0-9]{0,9}\\/?$/.test(parsed.pathname))return null;
 const configured=env.PUBLIC_BASE_URL;
 if(typeof configured==="string" && configured){
  try{
   const base=new URL(configured);
   if(base.protocol==="https:" && !base.username && !base.password &&
      !base.search && !base.hash && base.pathname==="/" &&
      base.href.replace(/\\/$/,"")===base.origin &&
      parsed.origin===base.origin)return parsed.pathname;
  }catch{ /* Invalid configuration never widens the trusted origins. */ }
 }
 return OWNED_PROMO_ORIGINS.has(parsed.origin)?parsed.pathname:null;
}
function storedClinicImageRef(url){
 const path=ownedImagePath(url);
 if(!path)return null;
 const match=/^\\/(promo-images|api\\/config\\/result-media\\/image)\\/([1-9][0-9]{0,9})\\/?$/.exec(path);
 if(!match)return null;
 const id=Number(match[2]);
 if(!Number.isSafeInteger(id)||id<=0)return null;
 return {id,purpose:match[1]==="promo-images"?"public_config":"result_media"};
}
async function loadOwnedClinicImage(url,{repository=promoImages}={}){
 const ref=storedClinicImageRef(url);
 if(!ref)return null;
 const image=await repository.getImage(ref.id);
 if(!image || image.purpose!==ref.purpose ||
    !["image/jpeg","image/png"].includes(image.mime_type) ||
    typeof image.data!=="string" ||
    image.data.length<8 || image.data.length>Math.ceil(MAX_IMAGE_BYTES*4/3)+12 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data))return null;
 const buffer=Buffer.from(image.data,"base64");
 if(buffer.length===0 || buffer.length>MAX_IMAGE_BYTES)return null;
 const mimeType=image.mime_type;
 // The trusted configuration references a DB image, never an arbitrary URL.
 return {buffer,mimeType,filename:mimeType==="image/jpeg"?"clinic-promo.jpg":"clinic-result.png"};
}
module.exports={MAX_IMAGE_BYTES,storedClinicImageRef,loadOwnedClinicImage};
