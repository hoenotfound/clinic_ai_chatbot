const { detectMessageLanguage } = require("./chatLanguage");
const {
  URGENT_SAFETY_PATTERNS,
  isUrgentSafetyMessage,
} = require("./attentionTriggers");

function fallbackHandoffReply(messageText, configuredEnglish) {
  const language = detectMessageLanguage(messageText);

  if (isUrgentSafetyMessage(messageText)) {
    if (language === "zh") {
      return "这个情况可能需要尽快处理。请现在直接联系诊所；如果症状严重、越来越严重，或有呼吸困难，请立即寻求紧急医疗帮助。我也已经通知我们的团队跟进你。";
    }
    if (language === "ms") {
      return "Yang ni mungkin perlukan perhatian segera. Tolong hubungi klinik terus sekarang; kalau simptom teruk, makin teruk, atau susah bernafas, dapatkan rawatan kecemasan segera. Saya juga dah flag pada team kami untuk follow up.";
    }
    return "This could need urgent medical attention. Please contact the clinic directly now; if the symptoms are severe, getting worse, or you're having trouble breathing, seek emergency medical care immediately. I've also flagged this for our team.";
  }

  if (language === "zh") {
    return "这个情况我帮你转给我们的团队确认比较好，他们会在这里跟进你。";
  }
  if (language === "ms") {
    return "Untuk yang ni, saya minta team kami check dan bantu ya. Mereka akan follow up dengan awak dekat sini.";
  }
  return String(configuredEnglish || "").trim() ||
    "For this one I'll get our team to check properly for u. They'll follow up with u here shortly 👍";
}

module.exports = {
  URGENT_SAFETY_PATTERNS,
  fallbackHandoffReply,
  isUrgentSafetyMessage,
};
