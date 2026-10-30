"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {isCurrentApprovedClinicImage}=require("../src/services/whatsappSecondaryClinicMediaAuthorization");
const now=new Date("2026-10-30T01:30:00Z");
const url="/api/config/result-media/image/23";
const cfg={promotions:[{
 validFrom:"2026-10-01",validUntil:"2026-10-31",
 packages:[{imageUrl:"https://clinic.example/promo-images/32",
  mediaTranslations:{zh:{imageUrl:"https://clinic.example/promo-images/33"}}}],
}],resultMedia:[{enabled:true,triggerMode:"service_enquiry",items:[{
 imageUrl:url,mediaTranslations:{ms:{imageUrl:"/api/config/result-media/image/24"}},
}]}]};
const approved=(imageUrl,kind,config=cfg,at=now)=>
 isCurrentApprovedClinicImage({imageUrl,kind,config,now:at});
test("one current configured promotion or result image is allowed only in its own category",()=>{
 assert.equal(approved("https://clinic.example/promo-images/32","promotion"),true);
 assert.equal(approved("https://clinic.example/promo-images/33","promotion"),true);
 assert.equal(approved(url,"result"),true);
 assert.equal(approved("/api/config/result-media/image/24","result"),true);
 assert.equal(approved(url,"promotion"),false);
 assert.equal(approved("https://clinic.example/promo-images/32","result"),false);
});
test("removed, disabled, expired and replaced assets fail closed",()=>{
 assert.equal(approved(url,"result",{...cfg,resultMedia:[]}),false);
 assert.equal(approved(url,"result",{...cfg,resultMedia:[{...cfg.resultMedia[0],enabled:false}]}),false);
 assert.equal(approved(url,"result",{...cfg,resultMedia:[{...cfg.resultMedia[0],triggerMode:"off"}]}),false);
 assert.equal(approved("https://clinic.example/promo-images/32","promotion",cfg,
  new Date("2026-11-01T01:00:00Z")),false);
 assert.equal(approved("https://clinic.example/promo-images/32","promotion",
  {...cfg,promotions:[{...cfg.promotions[0],enabled:false}]}),false);
 assert.equal(approved(url,"result",{...cfg,resultMedia:[{
  ...cfg.resultMedia[0],items:[{imageUrl:"/api/config/result-media/image/99"}],
 }]}),false);
 assert.equal(approved(url,"template"),false);
 assert.equal(approved(url,"result",null),false);
});
