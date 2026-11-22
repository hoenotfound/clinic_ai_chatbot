"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const { assessmentFirstInvitation, ensureFirstAssessmentInvitation } =
  require("../src/utils/initialOfferReplyGuard");
const { templateText, verifiedPelvicAssessmentVoucher } =
  require("../src/utils/clinicAssessmentReplyTemplates");

const services = [{name:"骨盆调理"},{name:"3D 小颜术"},{name:"9D 逆龄抗衰"}];
const promo = {
  linkedService:"骨盆调理",
  validFrom:"2000-01-01",validUntil:"2999-12-31",
  packages:[{name:"Package A",caption:"RM100 优惠券, 使用条件由门店确认"}],
};
const copies = {
  zh: {
    pelvicFree:"Neon 自定义免费1对1体态评估 + 体验，由中医师了解你的体态",
    pelvicStandard:"Neon 自定义1对1体态评估 + 体验",
    face:"Neon 自定义脸部评估：{service}，由中医师了解脸型",
    general:"Neon 自定义评估 {service}",
    body:"Neon 自定义体态评估 + 体验",
    valuePelvic:"Neon 自定义了解你的体态和困扰，才建议适合的护理",
    valueFace:"Neon 自定义了解你在意的脸型和紧致问题",
    valueGeneral:"Neon 自定义了解你的身体情况",
    dayQuestion:"你哪一天比较方便？我帮你向门店确认时间～",
    voucher:"Neon 自定义 RM100 骨盆调理优惠券，条件由门店确认",
  },
  en: {face:"Neon custom facial assessment for {service}",dayQuestion:"Which day works for you? The clinic will check."},
  ms: {face:"Penilaian wajah tersuai untuk {service}",dayQuestion:"Hari apa sesuai? Pusat akan semak."},
};

function withNeutro(callback) {
  const saved = {
    businessType:config.businessType,businessName:config.businessName,clinicName:config.clinicName,
    assessmentReplyTemplates:config.assessmentReplyTemplates,
    automatedFollowUp:config.automatedFollowUp,promotions:config.promotions,
  };
  Object.assign(config,{
    businessType:"tcm_clinic",businessName:"Neutro Sense TCM Centre",
    clinicName:"Neutro Sense TCM Centre",assessmentReplyTemplates:copies,
    promotions:[promo],
    automatedFollowUp:{...config.automatedFollowUp,complimentaryAssessmentExperienceEnabled:true},
  });
  try{return callback()}finally{Object.assign(config,saved)}
}

test("Neutro assessment replies take first-party text from editable Neon settings",()=>{
  withNeutro(()=>{
    const pelvis=assessmentFirstInvitation({
      treatment:"骨盆调理",customerText:"我想了解骨盆调理",
      services,language:"zh",
    });
    assert.match(pelvis,/Neon 自定义免费1对1体态评估/);
    assert.match(pelvis,/Neon 自定义 RM100/);
    assert.doesNotMatch(pelvis,/AI 身体检测|已预约/);
    assert.equal((pelvis.match(/？/gu)||[]).length,1);
    const face=assessmentFirstInvitation({
      treatment:"3D 小颜术",customerText:"我想了解3D小颜术",
      services,language:"en",
    });
    assert.match(face,/Neon custom facial assessment for 3D 小颜术/);
    assert.doesNotMatch(face,/RM100|free|complimentary|pelvic/i);
    const ms=assessmentFirstInvitation({
      treatment:"9D 逆龄抗衰",customerText:"9D逆龄",
      services,language:"ms",
    });
    assert.match(ms,/Penilaian wajah tersuai untuk 9D 逆龄抗衰/);
  });
});

test("an expired pelvic offer cannot cause the configured voucher to be added",()=>{
  withNeutro(()=>{
    config.promotions=[];
    assert.equal(verifiedPelvicAssessmentVoucher(config),false);
    const reply=assessmentFirstInvitation({
      treatment:"骨盆调理",customerText:"骨盆调理",language:"zh",services,
    });
    assert.doesNotMatch(reply,/RM100/);
    const existing=ensureFirstAssessmentInvitation({
      isFirstMessage:true,customerText:"我想了解骨盆调理",
      treatment:"骨盆调理",language:"zh",services,
      reply:"我们可以先安排1对1体态评估，你比较方便平日还是周末呢？",
    });
    assert.doesNotMatch(existing.reply,/RM100/);
    assert.match(existing.reply,/Neon 自定义了解你的体态/);
  });
});

test("result questions are answered first without appending a new appointment pitch",()=>{
  withNeutro(()=>{
    for(const q of ["一次就见效果吗？","骨盆调理一次会有分别吗？","做一次有怎样的效果？"]) {
      const out=ensureFirstAssessmentInvitation({
        isFirstMessage:true,customerText:q,treatment:"骨盆调理",
        reply:"是的☺️ 这张案例的视觉变化可以参考，实际变化因人而异哦～",
        services,language:"zh",
      });
      assert.equal(out.appended,false,q);
      assert.doesNotMatch(out.reply,/RM100|哪一天/);
    }
  });
});

test("unrelated clinic does not inherit Neutro templates",()=>{
  withNeutro(()=>{
    config.businessName="Other TCM";
    config.clinicName="Other TCM";
    const reply=assessmentFirstInvitation({
      treatment:"3D 小颜术",customerText:"3D小颜术",language:"en",services,
    });
    assert.doesNotMatch(reply,/Neon custom/);
    assert.match(reply,/TCM practitioner/);
  });
});

test("clinic config save contract retains the editable assessment templates",()=>{
  const { CONFIG_KEYS, hydrateStoredConfig } = require("../src/db/configRepo");
  assert.ok(CONFIG_KEYS.includes("assessmentReplyTemplates"));
  const hydrated=hydrateStoredConfig({
    businessType:"tcm_clinic",businessName:"Neutro Sense TCM Centre",
    assessmentReplyTemplates:copies,
  });
  assert.equal(templateText(hydrated,"zh","pelvicFree"),copies.zh.pelvicFree);
  assert.equal(templateText(hydrated,"en","face","3D 小颜术"),
    "Neon custom facial assessment for 3D 小颜术");
});
