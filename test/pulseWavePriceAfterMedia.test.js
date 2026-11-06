"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { verifiedPricesForService } = require("../src/utils/verifiedPriceReply");
const { resolveEstablishedTreatmentPrice } = require("../src/utils/priceConversationRecovery");
const { resolveAiPricingDecision } = require("../src/utils/aiPricingIntentDecision");
const { resolveShadowPriceException } = require("../src/utils/shadowPriceException");
const { hasClinicalMediaRisk } = require("../src/utils/aiReviewPolicy");
const { assistantIntroducesCompetingPaidService } = require("../src/utils/priceFollowUpContext");
const { serviceCandidates } = require("../src/utils/conversationPromptContext");
const fixture = {
  "services": [
    {
      "name": "1对1体态评估"
    },
    {
      "name": "徒手体态调理"
    },
    {
      "name": "3D 小颜术"
    },
    {
      "name": "9D 逆龄抗衰"
    },
    {
      "name": "3D + 9D 组合"
    },
    {
      "name": "骨盆调理"
    },
    {
      "name": "脉冲波调理"
    },
    {
      "name": "产后调理"
    },
    {
      "name": "子宫调理"
    },
    {
      "name": "艾灸"
    },
    {
      "name": "草药胸部疏通乳腺护理"
    }
  ],
  "aliases": [
    {
      "alias": "体态评估",
      "officialService": "1对1体态评估"
    },
    {
      "alias": "身体评估",
      "officialService": "1对1体态评估"
    },
    {
      "alias": "1对1评估",
      "officialService": "1对1体态评估"
    },
    {
      "alias": "posture assessment",
      "officialService": "1对1体态评估"
    },
    {
      "alias": "徒手调理",
      "officialService": "徒手体态调理"
    },
    {
      "alias": "体态调整",
      "officialService": "徒手体态调理"
    },
    {
      "alias": "整骨",
      "officialService": "徒手体态调理"
    },
    {
      "alias": "posture adjustment",
      "officialService": "徒手体态调理"
    },
    {
      "alias": "body alignment",
      "officialService": "徒手体态调理"
    },
    {
      "alias": "小颜术",
      "officialService": "3D 小颜术"
    },
    {
      "alias": "3D小颜",
      "officialService": "3D 小颜术"
    },
    {
      "alias": "3D小脸",
      "officialService": "3D 小颜术"
    },
    {
      "alias": "3D调整",
      "officialService": "3D 小颜术"
    },
    {
      "alias": "3D小颜术",
      "officialService": "3D 小颜术"
    },
    {
      "alias": "整骨小颜术",
      "officialService": "3D 小颜术"
    },
    {
      "alias": "小颜整骨",
      "officialService": "3D 小颜术"
    },
    {
      "alias": "美颜整骨",
      "officialService": "3D 小颜术"
    },
    {
      "alias": "3D face bone correction",
      "officialService": "3D 小颜术"
    },
    {
      "alias": "9D",
      "officialService": "9D 逆龄抗衰"
    },
    {
      "alias": "9D抗衰",
      "officialService": "9D 逆龄抗衰"
    },
    {
      "alias": "9D紧致",
      "officialService": "9D 逆龄抗衰"
    },
    {
      "alias": "Firm & Lift",
      "officialService": "9D 逆龄抗衰"
    },
    {
      "alias": "9D逆龄抗衰",
      "officialService": "9D 逆龄抗衰"
    },
    {
      "alias": "9D逆龄抗衰精雕",
      "officialService": "9D 逆龄抗衰"
    },
    {
      "alias": "9D逆龄精雕",
      "officialService": "9D 逆龄抗衰"
    },
    {
      "alias": "9D抗衰精雕",
      "officialService": "9D 逆龄抗衰"
    },
    {
      "alias": "9D提拉",
      "officialService": "9D 逆龄抗衰"
    },
    {
      "alias": "3D+9D",
      "officialService": "3D + 9D 组合"
    },
    {
      "alias": "9D+3D",
      "officialService": "3D + 9D 组合"
    },
    {
      "alias": "3D + 9D",
      "officialService": "3D + 9D 组合"
    },
    {
      "alias": "9D + 3D",
      "officialService": "3D + 9D 组合"
    },
    {
      "alias": "3D9D组合",
      "officialService": "3D + 9D 组合"
    },
    {
      "alias": "9D3D组合",
      "officialService": "3D + 9D 组合"
    },
    {
      "alias": "3D 9D 组合",
      "officialService": "3D + 9D 组合"
    },
    {
      "alias": "9D 3D 组合",
      "officialService": "3D + 9D 组合"
    },
    {
      "alias": "骨盆",
      "officialService": "骨盆调理"
    },
    {
      "alias": "骨盆调整",
      "officialService": "骨盆调理"
    },
    {
      "alias": "骨盆调理",
      "officialService": "骨盆调理"
    },
    {
      "alias": "骨盆矫正",
      "officialService": "骨盆调理"
    },
    {
      "alias": "骨盘",
      "officialService": "骨盆调理"
    },
    {
      "alias": "骨盘调理",
      "officialService": "骨盆调理"
    },
    {
      "alias": "pelvic adjustment",
      "officialService": "骨盆调理"
    },
    {
      "alias": "脉冲波",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "脉冲",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "脉冲波塑形",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "pulse wave",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "pulsewave",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "智能减脂",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "中医减脂",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "脉冲波减脂",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "body contouring",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "产后",
      "officialService": "产后调理"
    },
    {
      "alias": "产后修复",
      "officialService": "产后调理"
    },
    {
      "alias": "产后恢复",
      "officialService": "产后调理"
    },
    {
      "alias": "postpartum recovery",
      "officialService": "产后调理"
    },
    {
      "alias": "postpartum care",
      "officialService": "产后调理"
    },
    {
      "alias": "子宫",
      "officialService": "子宫调理"
    },
    {
      "alias": "子宫护理",
      "officialService": "子宫调理"
    },
    {
      "alias": "womb care",
      "officialService": "子宫调理"
    },
    {
      "alias": "艾灸调理",
      "officialService": "艾灸"
    },
    {
      "alias": "moxibustion",
      "officialService": "艾灸"
    },
    {
      "alias": "胸部护理",
      "officialService": "草药胸部疏通乳腺护理"
    },
    {
      "alias": "草药胸部护理",
      "officialService": "草药胸部疏通乳腺护理"
    },
    {
      "alias": "乳腺护理",
      "officialService": "草药胸部疏通乳腺护理"
    },
    {
      "alias": "胸部疏通",
      "officialService": "草药胸部疏通乳腺护理"
    },
    {
      "alias": "herbal breast care",
      "officialService": "草药胸部疏通乳腺护理"
    },
    {
      "alias": "中医智能减脂",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "中医智能脉冲波",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "脉冲波治疗",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "中医徒手整骨",
      "officialService": "徒手体态调理"
    },
    {
      "alias": "中医徒手整骨调理",
      "officialService": "徒手体态调理"
    },
    {
      "alias": "徒手矫正",
      "officialService": "徒手体态调理"
    },
    {
      "alias": "脊椎侧弯脉冲波",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "脊椎侧弯脉冲波治疗",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "3D",
      "officialService": "3D 小颜术"
    },
    {
      "alias": "全身整骨",
      "officialService": "徒手体态调理"
    },
    {
      "alias": "脸部整骨",
      "officialService": "3D 小颜术"
    },
    {
      "alias": "骨盆整骨",
      "officialService": "骨盆调理"
    },
    {
      "alias": "face alignment",
      "officialService": "3D 小颜术"
    },
    {
      "alias": "facial alignment",
      "officialService": "3D 小颜术"
    },
    {
      "alias": "Pelvic",
      "officialService": "骨盆调理"
    },
    {
      "alias": "Pelvic Care",
      "officialService": "骨盆调理"
    },
    {
      "alias": "Pelvic Treatment",
      "officialService": "骨盆调理"
    },
    {
      "alias": "Pelvis",
      "officialService": "骨盆调理"
    },
    {
      "alias": "脉冲能量波",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "脈衝能量波",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "脉冲能量波护理",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "脉冲能量波调理",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "脉冲波护理",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "pulse energy wave",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "pulse wave treatment",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "rawatan pulse wave",
      "officialService": "脉冲波调理"
    },
    {
      "alias": "gelombang denyutan",
      "officialService": "脉冲波调理"
    }
  ],
  "promotions": [
    {
      "name": "脉冲波调理 Promotion",
      "caption": "你可以上门来做个简查，我们的资深中医师会让你知道怎样去解决问题喔！\n\n\n【脉冲能量波】\n1次只需要\nRM388❗\n做完全身❗️\n不止改善偏头痛，\n还可以调理身体质，\n瘦身减肥！\n\n\n1 次 有明显效果🧨\n\n🎁 线上预约再送\n【艾灸桶疗程】加速新陈代谢，血液循环\n\n⏰ 整套体验约2小时15分钟（包含线上预约赠送的艾灸桶护理）～\n⭐️ 并且会针对性加强解决指定部位\n\n请问你平日还是周末比较方便呢？😊\n\n我们可以先预约日期和时间喔❤️",
      "pricing": {
        "offer": 388,
        "normal": 688,
        "currency": "MYR"
      },
      "imageUrl": "https://da-chatbot-neutro-sense-tcm.onrender.com/promo-images/37",
      "packages": [],
      "validFrom": null,
      "validUntil": null,
      "linkedService": "脉冲波调理",
      "followUpMessage": "Hi～你之前了解的【脉冲波调理】首次体验只需 RM388（原价 RM688）😊\n\n⏰ 整套预约约2小时15分钟，已包含线上预约赠送的【艾灸桶护理】，不需要额外加时间。\n\n中医师会先了解你在意的部位，再评估适合的护理安排；每个人实际体验和变化都可能不同。\n\n请问你平日还是周末比较方便呢？😊",
      "sendOnPriceQuery": true,
      "mediaTranslations": {
        "en": {
          "caption": "✨ Neutro Sense Pulse Wave | First Trial RM388 (normal price RM688)\n\nPulse Wave is a device-assisted treatment used in selected body-conditioning and body-contouring programmes. Our TCM practitioner will assess your concerns and areas to focus on first.\n\n⏰ The COMPLETE first-trial appointment takes approximately 2 hours 15 minutes, INCLUDING the complimentary 艾灸桶 (moxibustion barrel) care. This is the combined visit duration, not additional time on top of the gift.\n\n🎁 The complimentary care is included for online bookings under this promotion.\n\nIndividual results vary and cannot be guaranteed.\n\nWould weekdays or weekends suit you better? 😊"
        },
        "ms": {
          "caption": "✨ Pulse Wave Neutro Sense | Harga promosi RM388 (harga asal RM688)\n\nPulse Wave ialah rawatan berbantukan alat bagi program penjagaan dan kontur badan tertentu. Pengamal TCM akan menilai keadaan serta bahagian yang ingin anda utamakan terlebih dahulu.\n\n⏰ Tempoh KESELURUHAN lawatan percubaan kira-kira 2 jam 15 minit, TERMASUK penjagaan 艾灸桶 (moksibusi) percuma. Ini bukan masa tambahan selepas rawatan tersebut.\n\n🎁 Penjagaan percuma disertakan bagi tempahan dalam talian di bawah promosi semasa.\n\nHasil berbeza mengikut individu dan tidak dijamin.\n\nAnda lebih selesa datang pada hari bekerja atau hujung minggu? 😊"
        }
      },
      "followUpTranslations": {
        "en": "Hi 😊 Pulse Wave First Trial RM388 (normal price RM688).\n\n⏰ The complete appointment takes around 2 hours 15 minutes, INCLUDING the complimentary 艾灸桶 (moxibustion barrel) care provided with online bookings. No additional appointment time is needed for the complimentary care.\n\nOur TCM practitioner will first understand your concerns and assess suitable care. Individual results vary.\n\nWould weekdays or weekends suit you better?",
        "ms": "Hai 😊 Harga promosi RM388 (harga asal RM688) untuk percubaan Pulse Wave.\n\n⏰ Tempoh keseluruhan lawatan kira-kira 2 jam 15 minit, TERMASUK penjagaan 艾灸桶 (moksibusi) percuma bagi tempahan dalam talian. Masa tambahan tidak diperlukan untuk penjagaan percuma ini.\n\nPengamal TCM akan menilai keperluan anda terlebih dahulu. Hasil berbeza mengikut individu.\n\nHari bekerja atau hujung minggu lebih sesuai?",
        "zh": "Hi～你之前了解的【脉冲波调理】首次体验只需 RM388（原价 RM688）😊\n\n⏰ 整套预约约2小时15分钟，已包含线上预约赠送的【艾灸桶护理】，不需要额外加时间。\n\n中医师会先了解你在意的部位，再评估适合的护理安排；每个人实际体验和变化都可能不同。\n\n请问你平日还是周末比较方便呢？😊"
      }
    }
  ],
  "turns": [
    [
      "user",
      "我想了解脉冲波调理",
      269000
    ],
    [
      "assistant",
      "脉冲波调理主要是用仪器辅助来做身体局部塑形或产后调理，也有人称为中医智能减脂～具体做哪个部位还是要看你的体态和实际需求。你目前主要是在意腹部、腰围，还是产后身体变化这块呢？",
      262000
    ],
    [
      "assistant",
      "这是 Neutro Sense 脉冲波调理顾客的 Before & After 参考图 😊\n这是个别护理案例，实际变化因人而异，无法保证每个人都有相同效果。",
      260000
    ],
    [
      "assistant",
      "再分享一组 Neutro Sense 脉冲波调理的顾客 Before & After 参考图 😊\n图片仅供个别案例参考，是否适合调理及实际变化需由中医师评估。",
      195000
    ],
    [
      "user",
      "会疼吗",
      26800
    ],
    [
      "assistant",
      "调理过程中一般是温热和肌肉收缩的感觉，大部分顾客都觉得是可以接受的，中医师也会根据你的耐受度来调节强度哦 😊 你主要是想调理哪一个部位呢？",
      18700
    ],
    [
      "user",
      "这个多少钱？",
      1000
    ]
  ]
};

test("Neutro Pulse Wave real-price sequence after Before & After and pain question", () => {
  const now = Date.now();
  const history = fixture.turns.map(([role, content, age]) => ({
    role, content, pricingCreatedAtMs: now - age, pricingStaffAuthored: false,
  }));
  const priceQuestion = history.at(-1).content;
  const base = {customerText: priceQuestion, conversationHistory: history,
    services: fixture.services, serviceAliases: fixture.aliases,
    promotions: fixture.promotions, now};
  assert.equal(hasClinicalMediaRisk(history.at(-3).content), false,
    "Pain question should not automatically be treated as a red-flag clinical inquiry");
  const verified = verifiedPricesForService("脉冲波调理", fixture.promotions,
    priceQuestion, history);
  assert.deepEqual(verified?.map(x => x.price), ["RM388"],
    "Structured first-trial offer must agree with all configured language captions");
  const established = resolveEstablishedTreatmentPrice({...base, session: history});
  assert.equal(established?.name, "脉冲波调理",
    "The user's explicit treatment name must survive subsequent ordinary Q&A and media captions");
  const ai = resolveAiPricingDecision({...base, priceQuery: true,
    complimentaryAssessmentExperienceEnabled:true, allowOfferEnquiries:true});
  assert.equal(ai?.treatment, "脉冲波调理",
    "Current explicit price question must retain the latest customer-chosen treatment");
  assert.deepEqual(ai?.prices?.map(x => x.price), ["RM388"]);
  const shadow = resolveShadowPriceException({...base,
    complimentaryAssessmentExperienceEnabled:true, allowOfferEnquiries:true});
  assert.equal(shadow?.treatment, "脉冲波调理",
    "Shadow pricing should verify an unchanged treatment after media and a pain question");
  assert.deepEqual(shadow?.prices?.map(x => x.price), ["RM388"]);
});


test("Pulse Wave postpartum application is not a separate package; a genuine other service remains blocked", () => {
  const candidates = serviceCandidates(fixture.services, fixture.aliases);
  assert.equal(assistantIntroducesCompetingPaidService({
    role: "assistant",
    content: "脉冲波调理主要是用仪器辅助来做身体局部塑形或产后调理，也有人称为中医智能减脂。",
  }, "脉冲波调理", candidates), false);
  assert.equal(assistantIntroducesCompetingPaidService({
    role: "assistant",
    content: "脉冲波调理是一个项目，另外我们也提供产后调理，想了解哪一个？",
  }, "脉冲波调理", candidates), true);
  assert.equal(assistantIntroducesCompetingPaidService({
    role: "assistant",
    content: "脉冲波调理主要是辅助身体护理。另外还提供产后调理。",
  }, "脉冲波调理", candidates), true);
  assert.equal(assistantIntroducesCompetingPaidService({
    role: "assistant",
    content: "脉冲波调理 RM388，也有产后调理 RM288。",
  }, "脉冲波调理", candidates), true);
});
