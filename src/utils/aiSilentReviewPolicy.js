// Fail closed when a purported normal answer is actually an inability to
// answer, without suppressing ordinary apologies or factual service limits.
const UNANSWERABLE = [
  /\b(?:sorry[,! ]*\s*)?(?:i|we)\s+(?:can(?:not|'t)|(?:am|are)\s+unable\s+to)\s+(?:answer|respond\s+to|help\s+(?:you\s+)?with|provide\s+(?:an?\s+)?answer\s+to)\b/i,
  /\b(?:as\s+an?\s+ai|as\s+a\s+(?:bot|chatbot))\b/i,
  /(?:抱歉|不好意思|对不起|對不起)?.{0,12}(?:我|我们|我們)(?:无法|無法|不能)(?:回答|解答|确认|確認|提供答案)/u,
  /\b(?:maaf[,! ]*)?(?:saya|kami)\s+(?:tak|tidak)\s+(?:boleh|dapat)\s+(?:jawab|menjawab)\b/i,
  /\b(?:i(?:'ll| will)|we(?:'ll| will))\s+(?:ask|check\s+with|refer\s+(?:this|that|your\s+question)\s+to)\s+(?:our\s+)?(?:team|staff|colleagues)\b/i,
  /(?:要|需要|让我|讓我)(?:先)?(?:问|問|找|跟)(?:同事|团队|團隊|客服)(?:确认|確認|了解)/u,
];
const IDENTITY_QUESTION = /\b(?:are\s+you|is\s+this|am\s+i\s+(?:talking|speaking)\s+to)\s+(?:an?\s+)?(?:ai|bot|chatbot|robot|human|real\s+person)\b|(?:你是|妳是|是不是)(?:AI|人工智能|机器人|機器人|真人|人工客服)|\b(?:awak|anda)\s+(?:bot|ai)\b/iu;

function isUnanswerableCustomerReply(reply, customerText = "") {
  const value = String(reply || "").trim();
  if (!value) return true;
  if (IDENTITY_QUESTION.test(String(customerText || "")) &&
      /\b(?:as\s+an?\s+ai|as\s+a\s+(?:bot|chatbot))\b/i.test(value)) return false;
  return UNANSWERABLE.some((pattern) => pattern.test(value));
}

module.exports = { isUnanswerableCustomerReply };
