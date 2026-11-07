"use strict";

// A standalone greeting is not a medical problem, even when a language model
// incorrectly marks it for silent clinical review. This only repairs the model
// classification; an independently pending clinical review still blocks it.
const SIMPLE_GREETING =
  /^(?:(?:hi+|hello+|hey+|hiya|hai+|helo+|salam|assalamualaikum|good[ ]*(?:morning|afternoon|evening)|morning|afternoon|evening)(?:[ ]+there)?|(?:你好|您好|嗨|哈喽|哈囉|早安|午安|晚上好|早上好|嗨嗨|你好啊|您好啊))[ ,.!?？。！，～~👋😊🙏🙂]*$/iu;

function isSimpleGreeting(text) {
  const value = String(text || "").trim();
  return value.length > 0 && value.length <= 55 && SIMPLE_GREETING.test(value);
}
function safeGreetingReply(language="en") {
  const locale = String(language || "").toLowerCase();
  return locale.startsWith("zh")
    ? "你好 😊 想了解哪方面的护理呢？我可以为你介绍。"
    : locale.startsWith("ms")
      ? "Hai 😊 Rawatan yang mana anda ingin tahu lebih lanjut?"
      : "Hi 😊 Which treatment would you like to know more about?";
}
module.exports={isSimpleGreeting,safeGreetingReply};
