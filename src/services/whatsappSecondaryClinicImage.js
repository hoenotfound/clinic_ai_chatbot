"use strict";
// Settings-managed clinic media uses two distinct access policies.
// Before/After results are PRIVATE; never expose their HTTP preview URL to
// Meta or another user. Load bytes server-side and upload with the verified
// secondary WABA token at the last outbound transport boundary.
const promoImages=require("../db/promoImagesRepo");
const MAX_IMAGE_BYTES=5*1024*1024;
function storedClinicImageRef(url){
 if(typeof url!=="string" || url.length>255)return null;
 const match=/^\/(promo-images|api\/config\/result-media\/image)\/([1-9][0-9]{0,9})\/?$/.exec(url);
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
