"use strict";
// Customer treatment selections must be affirmative, not negative,
// informational, comparative or marketing-only mentions.
const NAME={
 herbal:/(?:草药|草藥|herbal).{0,16}(?:胸部|乳腺|breast)/iu,
 pulse:/(?:全身脉冲|全身脈衝|脉冲波调理|脈衝波調理|黄金脉冲|黃金脈衝|full.body\s+pulse)/iu,
};
const POSITIVE=/(?:我(?:想|要)(?:做|预约|預約|安排|试|試|选|選)|(?:请|請)?(?:帮|幫)我(?:预约|預約|安排)|(?:我)?(?:决定|決定|确定|確定|选择|選擇)(?:做|这个|這個)?|i(?:'d| would)\s+like\s+to\s+(?:book|try|have|do)|i\s+want\s+to\s+(?:book|try|have|do)|please\s+book|book\s+me|(?:nak|mahu)\s+(?:book|tempah|buat))/iu;
const NEGATIVE=/(?:不想|不要|不做|不需要|不选|不選|不考虑|不考慮|没兴趣|沒興趣|不感兴趣|不感興趣|不是|不适合|不適合|不能|取消|退订|退訂|拒绝|拒絕|只是(?:问|問|了解|看看|比较|比較)|仅(?:想)?(?:了解|问|問)|只有(?:问|問)|比较|比較|对比|對比|区别|區別|差别|差別|不同|而不是|并非|並非|instead\s+of|not\s+(?:interested|book|want)|(?:do\s+not|don't|dont|won't|wouldn't)\s+(?:want|book|choose|do)|cancel)/iu;
function customerExplicitTreatmentChoice(message,treatment){
 const v=String(message||"").normalize("NFKC").replace(/\s+/gu," ").trim();
 const name=NAME[treatment];
 if(!name||!v||v.length>400||NEGATIVE.test(v))return false;
 const m=v.match(name);
 if(!m)return false;
 const before=v.slice(Math.max(0,m.index-42),m.index);
 const after=v.slice(m.index+m[0].length,m.index+m[0].length+32);
 return POSITIVE.test(before)||POSITIVE.test(after);
}
function latestCustomerTreatmentChoice(history,currentText,treatment){
 const name=NAME[treatment];
 if(!name)return false;
 const current=String(currentText||"");
 // A new RM68 enquiry is not consent to recycle an older herbal choice.
 if(/\b(?:RM|MYR)\s*68\b/iu.test(current)&&!name.test(current))return false;
 const texts=[...(Array.isArray(history)?history.filter(x=>x?.role==="user")
  .map(x=>String(x.content||"")):[]),current];
 const last=texts.filter(x=>name.test(x)).at(-1);
 return Boolean(last&&customerExplicitTreatmentChoice(last,treatment));
}
module.exports={customerExplicitTreatmentChoice,latestCustomerTreatmentChoice};
