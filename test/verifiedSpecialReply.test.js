"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {selectVerifiedSpecialReply,verifiedEquivalentReply}=require("../src/utils/verifiedSpecialReply");

const decision={reply:"Here's the difference:\nPackage A (RM388 | 150 minutes):\n• Pelvic care\n• Meridian massage\nPackage B (RM268 | 60 minutes):\n• Pelvic care\nOur practitioner can help you choose.",
  heading:"Here's the difference:",conclusion:"Our practitioner can help you choose.",
  verifiedPackages:[{name:"Package A",price:388,title:"150 minutes",includedItems:["Pelvic care","Meridian massage"]},{name:"Package B",price:268,title:"60 minutes",includedItems:["Pelvic care"]}]};
const select=draft=>selectVerifiedSpecialReply({draft,decision,language:"en",kind:"pelvic"});
test("pelvic comparison preserves reordered independently verified package facts without compulsory invitation",()=>{
  const draft="Hi 😊\nPackage B (MYR 268.00 | 60 minutes):\n• Pelvic care\nPackage A (RM388 | 150 minutes):\n• Meridian massage\n• Pelvic care";
  assert.equal(select(draft),draft);
  for(const bad of [draft.replace("MYR 268.00","RM388"),draft.replace("60 minutes","90 minutes"),draft.replace("Meridian massage","Free gifts"),draft+"\nGuaranteed results",draft.replace("• Meridian massage","❌ Meridian massage"),draft.replace("RM388","RM388.50"),draft.replace("• Meridian massage","• Meridian massage\n• Free consultation")])assert.equal(select(bad),decision.reply,bad);
});
test("combo reply equivalence accepts currency formats and neutral greetings but not unsupported conditions",()=>{
  const reference="The current 3D + 9D combination offer is RM688 😊 Our practitioner will assess whether both treatments are suitable.";
  const draft="Hello 😊\nThe current 3D + 9D combination offer is MYR 688.00. Our practitioner will assess whether both treatments are suitable.";
  // Exact sentence boundary is part of the approved claim. Currency format,
  // friendly decoration and standalone greetings may differ.
  const equivalent=draft.replace("688.00. Our","688.00 😊 Our");
  assert.equal(verifiedEquivalentReply(equivalent,reference),true);
  for(const bad of [reference.replace("RM688","RM6880"),reference.replace("RM688","RM688 + 20"),reference.replace("suitable","guaranteed to work"),"❌ "+reference])assert.equal(verifiedEquivalentReply(bad,reference),false,bad);
});
test("later-session package invitation remains exact for delivery history recognition",()=>{
  const reference="Our team can explain the available package options.";
  const draft="Hi 😊\n"+reference;
  for(const mode of ["before_promo","staff_handoff","suggest_package"]){
    const reply=selectVerifiedSpecialReply({draft,decision:{reply:reference,mode},language:"en",kind:"subsequent"});
    assert.equal(reply,mode==="suggest_package"?reference:draft);
  }
});
