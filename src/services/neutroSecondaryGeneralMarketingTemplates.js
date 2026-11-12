"use strict";
// Pinned to the 12 independently approved SECONDARY-account Meta templates.
// A changed/replaced template, wrong sender, button, media, or language fails
// the static signature check before any provider call.
const {normalizeTemplate,templateSignature}=require("./whatsappTemplateService");
const {GENERAL_TEMPLATE_BY_SLOT}=require("./neutroSecondaryGeneralMarketingSql");
const APPROVED=Object.freeze({
  "48": {
    "zh_CN": {
      "id": "1905472777488799",
      "body": "您好～谢谢您关注 Neutro Sense TCM 😊 如果想了解我们的中医护理或首次评估，欢迎告诉我们您最关心的情况，我们可以为您说明。"
    },
    "en_US": {
      "id": "1678631883658802",
      "body": "Hello 😊 Thanks for your interest in Neutro Sense TCM. If you have questions about our TCM care or first assessment, reply whenever convenient."
    },
    "ms": {
      "id": "1050283584461707",
      "body": "Hai 😊 Terima kasih kerana berminat dengan Neutro Sense TCM. Kalau ada soalan tentang penjagaan TCM atau penilaian pertama, boleh balas mesej ini."
    }
  },
  "66": {
    "zh_CN": {
      "id": "1428658446081895",
      "body": "您好 😊 想轻轻跟进一下。如果您对中医护理、评估流程或到店安排有疑问，随时回复我们就好，不需要现在作决定。"
    },
    "en_US": {
      "id": "934353596290800",
      "body": "Hello 😊 Just checking in. If you'd like to ask about TCM care, assessment or visiting us, reply anytime. No need to decide now."
    },
    "ms": {
      "id": "1014407884244968",
      "body": "Hai 😊 Sekadar susulan ringan. Kalau nak tahu tentang penjagaan TCM, penilaian atau lawatan, balas bila-bila masa. Tak perlu buat keputusan sekarang."
    }
  },
  "96": {
    "zh_CN": {
      "id": "1437971061777600",
      "body": "您好～关于 Neutro Sense TCM 的一对一评估，如果您还想多了解护理如何安排，我们可以先回答您的问题，再由中医师评估是否适合。"
    },
    "en_US": {
      "id": "2231905270698330",
      "body": "Hello 😊 Our individual assessment starts by understanding your concerns. If you'd like to know how it works, we can explain and the TCM practitioner can assess suitability."
    },
    "ms": {
      "id": "29319248334380148",
      "body": "Hai 😊 Semasa penilaian individu, kami akan fahami keperluan anda dahulu. Kalau nak tahu prosesnya, boleh tanya dan pengamal TCM boleh menilai kesesuaian rawatan."
    }
  },
  "144": {
    "zh_CN": {
      "id": "2101944657185777",
      "body": "您好 😊 这是这次的最后一次跟进。如果将来想了解我们的中医护理或预约评估，随时欢迎回复。谢谢您，祝您有美好的一天！"
    },
    "en_US": {
      "id": "29784962131111986",
      "body": "Hello 😊 This is our last follow-up for now. If you ever want to learn about TCM care or arrange an assessment, you're welcome to reply. Wishing you a lovely day!"
    },
    "ms": {
      "id": "1675055354240049",
      "body": "Hai 😊 Ini susulan terakhir kami buat masa ini. Jika nak tahu tentang penjagaan TCM atau aturkan penilaian, boleh balas bila-bila masa. Semoga hari anda baik!"
    }
  }
});
function pinned(slot,language){
 const n=GENERAL_TEMPLATE_BY_SLOT[Number(slot)],entry=APPROVED[Number(slot)]?.[language];
 if(!n||!entry)return null;
 const raw={id:entry.id,name:n,language,status:"APPROVED",category:"MARKETING",
   components:[{type:"BODY",text:entry.body}]};
 const normalized=normalizeTemplate(raw);
 if(!normalized.sendable||normalized.variableFields.length!==0||
    normalized.buttons.length!==0||normalized.header||normalized.footer||
    !normalized.body?.text)return null;
 return {name:n,language,id:entry.id,body:entry.body,signature:templateSignature(normalized)};
}
module.exports={APPROVED,pinned};
