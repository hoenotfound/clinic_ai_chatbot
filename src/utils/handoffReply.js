const { detectMessageLanguage } = require("./chatLanguage");

function fallbackHandoffReply(messageText, configuredEnglish) {
  const language = detectMessageLanguage(messageText);
  if (language === "zh") {
    return "这个情况我帮你转给我们的团队确认比较好，他们会在这里跟进你。";
  }
  if (language === "ms") {
    return "Untuk yang ni, saya minta team kami check dan bantu ya. Mereka akan follow up dengan awak dekat sini.";
  }
  return String(configuredEnglish || "").trim() ||
    "For this one I'll get our team to check properly for u. They'll follow up with u here shortly 👍";
}

module.exports = { fallbackHandoffReply };
