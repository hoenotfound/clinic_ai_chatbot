const pipelineRepo = require("../db/pipelineRepo");
const messagesRepo = require("../db/messagesRepo");
const clinicConfig = require("../config/clinicConfig");

const CONTEXT_MESSAGE_LIMIT = 8;
const MAX_EVIDENCE_CHARS = 200;

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const ABSOLUTE_REJECTION_PATTERNS = [
  /\b(?:wrong number|wrong person|you have the wrong (?:number|person))\b/,
  /\b(?:stop|don't|do not)\s+(?:message|messaging|text(?:ing)?|contact(?:ing)?|call(?:ing)?)\s+me\b/,
  /\b(?:remove|unsubscribe)\s+me\b/,
  /\b(?:salah nombor|salah orang)\b/,
  /\b(?:jangan|usah)\s+(?:mesej|hubungi|telefon|call)\s+(?:saya|aku)\b/,
  /(?:号码错了|打错了|找错人了|不是本人|别再联系|不要再联系|别发信息|不要发信息)/,
];

const DECLINE_PATTERNS = [
  /\b(?:i(?:'m| am)?\s+)?(?:not|no longer)\s+interested(?:\s+(?:anymore|in\s+(?:your\s+)?(?:service|services|treatment|treatments|clinic)))?(?:,?\s*(?:thanks?|thank you))?\s*[.!?]*$/,
  /\b(?:i\s+)?(?:don't|do not)\s+(?:want|need)\s+(?:this|it|that|the treatment|your services?|an?\s+appointment|to\s+(?:book|schedule|make an appointment))\b/,
  /\b(?:i(?:'m| am)?\s+)?(?:won't|will not|am not going to|not going to)\s+(?:book|schedule|make an appointment)\b/,
  /\bno\s+thanks?(?:\s+you)?\b/,
  /\b(?:not for me|i(?:'ll| will) pass)\b/,
  /\b(?:saya\s+)?(?:tak|tidak)\s+berminat(?:\s+(?:lagi|dengan\s+(?:servis|rawatan)(?:\s+(?:ini|anda|awak))?))?(?:,?\s*(?:terima kasih|thanks?))?\s*[.!?]*$/,
  /\b(?:saya\s+)?(?:tak|tidak)\s+(?:nak|mahu)\s+(?:ini|itu|rawatan\s+ini|servis\s+(?:ini|anda)|book|booking|buat\s+(?:appointment|temujanji|janji temu))\b/,
  /\b(?:saya\s+)?(?:tak|tidak)\s+(?:perlu|payah)(?:\s+(?:ini|itu|servis|rawatan))?(?:,?\s*(?:terima kasih|thanks?))?\s*[.!?]*$/,
  /^(?:terima kasih,?\s*)?(?:saya\s+)?(?:tak|tidak)\s+nak(?:,?\s*(?:terima kasih|thanks?))?\s*[.!?]*$/,
  /^(?:我)?(?:不感兴趣|没兴趣|沒有興趣|没有兴趣|不要了|不需要了|不用了|谢谢不用了?|謝謝不用了?)(?:，?(?:谢谢|謝謝))?[。.!！]*$/,
  /^(?:我)?(?:对|對)(?:你们|你們|这项|這項)?(?:服务|服務|疗程|療程)(?:不感兴趣|没兴趣|沒有興趣|没有兴趣)[。.!！]*$/,
  /^(?:我)?(?:不想|不要|不打算)(?:预约|預約|预订|預訂)[。.!！]*$/,
];

const POSITIVE_CONTRAST_PATTERN =
  /(?:\b(?:but|however|instead|tapi|tetapi)\b.*\b(?:interested|want|need|book|appointment|know more|how much|price|cost|nak|mahu|berminat|berapa|harga)\b|(?:但是|可是|不过|不過).*(?:想|要|有兴趣|有興趣|了解|预约|預約|多少钱|多少錢|价格|價格|价钱|價錢))/;

const UNCLEAR_BOOKING_PATTERNS = [
  /\b(?:maybe|perhaps|not ready|not yet|still thinking|just (?:asking|checking|browsing)|(?:don't|do not) want to book (?:yet|now)|not booking (?:yet|now))\b/,
  /\bi\s+(?:may|might)\s+(?:want\s+to\s+)?(?:book|schedule|come|visit)\b/,
  /\b(?:belum (?:bersedia|nak|mahu)|mungkin|masih fikir|tanya sahaja|tanya saja|survey dulu|(?:tak nak|tidak mahu) book (?:dulu|lagi|sekarang))\b/,
  /(?:可能|也许|也許|还不想预约|還不想預約|暂时不预约|暫時不預約|还没决定|還沒決定|先看看|只是问问|只是問問|以后再说|以後再說)/,
  /\b(?:visit|check|open)\s+(?:your\s+)?(?:website|site|page|instagram|facebook)\b/,
];

const NEGATED_BOOKING_PATTERNS = [
  /\b(?:don't|do not|not going to)\s+(?:want\s+to\s+)?(?:book|schedule|make an appointment)\b/,
  /\b(?:tak nak|tidak mahu|tak mahu)\s+(?:book|booking|buat appointment|buat temujanji)\b/,
  /(?:不想|不要|不打算)(?:预约|預約|预订|預訂)/,
];

const BOOKING_INTENT_PATTERNS = [
  /\b(?:i\s+)?(?:want|wanna|would like|i'd like|need|ready)\s+(?:to\s+)?(?:book|schedule|reserve|make\s+an?\s+appointment|come|visit)\b/,
  /\b(?:can|could|may)\s+(?:i|you)\s+(?:book|schedule|reserve|make\s+(?:me\s+)?an?\s+appointment)\b/,
  /\b(?:i\s+)?(?:want|would like|i'd like|need)\s+an?\s+(?:appointment|consultation|slot)\b/,
  /\b(?:can|could|may)\s+i\s+(?:come|visit\s+(?:the|your)?\s*(?:clinic|branch|centre|center))\b/,
  /\b(?:please\s+)?(?:book|schedule|reserve)\s+(?:me|an?\s+(?:appointment|slot)|a\s+slot)\b/,
  /\b(?:how|where)\s+(?:do|can)\s+i\s+(?:book|schedule|pay\s+(?:the\s+)?deposit)\b/,
  /\b(?:do you have|is there|are there|any)\b.{0,30}\b(?:appointments?|slots?|availability)\b/,
  /\b(?:appointments?|slots?)\s+(?:available|free)\b/,
  /\b(?:what|which)\s+(?:time|times|day|days|date|dates|slots?)\s+(?:is|are)?\s*(?:available|free)\b/,
  /\b(?:deposit|payment).{0,30}\b(?:book|booking|appointment|slot)\b/,
  /\b(?:saya\s+)?(?:nak|mahu|hendak)\s+(?:buat\s+)?(?:booking|book|appointment|temujanji|janji temu|datang|visit)\b/,
  /\b(?:boleh|tolong)\s+(?:saya\s+)?(?:book|booking|buat\s+(?:appointment|temujanji|janji temu))\b/,
  /\b(?:boleh|dapatkah)\s+(?:saya|kami)\s+datang\b/,
  /\b(?:ada|masih ada)\s+(?:slot|appointment|temujanji|janji temu)\b/,
  /\b(?:macam mana|bagaimana)\s+(?:nak|mahu)?\s*(?:book|booking|buat\s+(?:appointment|temujanji|janji temu))\b/,
  /\b(?:bila|pukul berapa)\s+(?:ada\s+)?(?:slot|boleh datang|available)\b/,
  /(?:我)?(?:想|要|准备|準備)(?:预约|預約|预订|預訂|订位|訂位|去你们|去你們|过去|過去|到店)/,
  /(?:可以|能不能|能|请|請|帮我|幫我)(?:帮我|幫我)?(?:预约|預約|预订|預訂|订位|訂位)/,
  /(?:有|还有|還有).{0,8}(?:空位|预约时间|預約時間|时间段|時間段|名额|名額)/,
  /(?:怎么|怎麼|如何|怎样|怎樣)(?:预约|預約|预订|預訂|付定金)/,
  /(?:哪天|几点|幾點|什么时间|什麼時間).{0,8}(?:有空|可以预约|可以預約|有位)/,
];

const SCHEDULING_PROMPT_PATTERNS = [
  /\b(?:would|do)\s+you\s+like\s+(?:me\s+)?to\s+(?:book|schedule|reserve)/,
  /\b(?:which|what)\s+(?:branch|day|date|time|slot)\b/,
  /\b(?:shall|can)\s+i\s+(?:book|schedule|confirm|reserve)/,
  /\b(?:appointment|booking|slot)\b.{0,60}\b(?:day|date|time|branch|confirm|available|work for you)\b/,
  /\b(?:cawangan|hari|tarikh|masa|pukul|slot|temujanji|janji temu)\b.{0,60}\b(?:mana|bila|sesuai|pilih|confirm|sahkan)\b/,
  /(?:要不要|需要我|可以帮你|可以幫你).{0,12}(?:预约|預約|订位|訂位)/,
  /(?:哪个|哪個|哪家|哪天|几号|幾號|几点|幾點|什么时间|什麼時間).{0,12}(?:分行|门店|門店|预约|預約|方便|合适|合適)/,
];

const CONFIRMATION_PATTERNS = [
  /^(?:yes|yes please|okay|ok|sure|please|confirm|confirmed|that works|sounds good)[.! ]*$/,
  /^(?:ya|ya boleh|boleh|ok boleh|setuju|baik|confirm|sahkan)[.! ]*$/,
  /^(?:好|好的|可以|确认|確認|确定|確定|没问题|沒問題)[。.! ]*$/,
];

const NON_CONFIRMING_SCHEDULING_PATTERNS = [
  /\b(?:can't|cannot|can not|unable|unavailable|not available|not free|doesn't work|does not work|won't work|will not work|need to reschedule|reschedule|cancel)\b/,
  /\b(?:tak boleh|tidak boleh|tak dapat|tidak dapat|tak free|tidak free|tak lapang|tidak lapang|tak sesuai|tidak sesuai|tukar|batal|cancel)\b/,
  /(?:不行|不可以|不能|没空|沒空|没有空|沒有空|不方便|改天|改期|取消)/,
];

const DATE_OR_TIME_PATTERNS = [
  /\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this\s+(?:week|weekend)|next\s+week|weekend)\b/,
  /\b(?:hari ini|esok|lusa|isnin|selasa|rabu|khamis|jumaat|sabtu|ahad|minggu ini|minggu depan|hujung minggu)\b/,
  /(?:今天|明天|后天|後天|星期[一二三四五六日天]|周[一二三四五六日天]|週[一二三四五六日天]|这个周末|這個週末|下周|下週)/,
  /\b(?:[01]?\d|2[0-3])[:.][0-5]\d\s*(?:am|pm)?\b/,
  /\b(?:[1-9]|1[0-2])\s*(?:am|pm)\b/,
  /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/,
  /\d{1,2}(?:点|點|时|時)/,
];

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function isExplicitRejection(text) {
  if (matchesAny(text, ABSOLUTE_REJECTION_PATTERNS)) return true;
  return (
    matchesAny(text, DECLINE_PATTERNS) &&
    !POSITIVE_CONTRAST_PATTERN.test(text) &&
    !matchesAny(text, UNCLEAR_BOOKING_PATTERNS)
  );
}

function hasBookingIntent(text) {
  return (
    matchesAny(text, BOOKING_INTENT_PATTERNS) &&
    !matchesAny(text, UNCLEAR_BOOKING_PATTERNS) &&
    !matchesAny(text, NEGATED_BOOKING_PATTERNS)
  );
}

function isSchedulingAnswer(text, branchNames) {
  if (
    matchesAny(text, UNCLEAR_BOOKING_PATTERNS) ||
    matchesAny(text, NON_CONFIRMING_SCHEDULING_PATTERNS)
  ) {
    return false;
  }

  if (matchesAny(text, CONFIRMATION_PATTERNS) || matchesAny(text, DATE_OR_TIME_PATTERNS)) {
    return true;
  }

  return (branchNames || []).some((branchName) => {
    const normalizedBranch = normalizeText(branchName);
    return normalizedBranch && text.includes(normalizedBranch);
  });
}

function classifyTemperatureMessage({
  messageText,
  previousClinicMessage = "",
  branchNames = [],
}) {
  const text = normalizeText(messageText);
  if (!text) return null;

  const rejected = isExplicitRejection(text);
  const bookingIntent = hasBookingIntent(text);
  if (rejected && bookingIntent) return null;

  const evidence = String(messageText).trim().slice(0, MAX_EVIDENCE_CHARS);
  if (rejected) {
    return {
      temperature: "cold",
      matchedRule: "explicit_rejection",
      reason: "The customer explicitly declined or asked not to be contacted.",
      evidence,
    };
  }
  if (bookingIntent) {
    return {
      temperature: "hot",
      matchedRule: "booking_intent",
      reason: "The customer showed clear booking or appointment intent.",
      evidence,
    };
  }

  const previous = normalizeText(previousClinicMessage);
  if (
    previous &&
    matchesAny(previous, SCHEDULING_PROMPT_PATTERNS) &&
    isSchedulingAnswer(text, branchNames)
  ) {
    return {
      temperature: "hot",
      matchedRule: "scheduling_confirmation",
      reason: "The customer confirmed scheduling details after a booking question.",
      evidence,
    };
  }

  return null;
}

function createLeadTemperatureReviewer({
  pipelineRepository,
  messagesRepository,
  getBranchNames,
}) {
  return async function reviewLeadTemperatureForMessage(contactId, messageId, messageText) {
    const lead = await pipelineRepository.getActiveLeadForContact(contactId);
    if (!lead || lead.temperature !== "warm") {
      return { status: "skipped", reason: "not-warm" };
    }
    if (lead.temperature_locked) {
      return { status: "skipped", reason: "staff-controlled" };
    }

    const branchNames = getBranchNames();
    let classification = classifyTemperatureMessage({ messageText, branchNames });

    // A short answer such as "Saturday", "3 pm", or a branch name only has
    // booking meaning when it follows a clinic scheduling question.
    if (!classification && isSchedulingAnswer(normalizeText(messageText), branchNames)) {
      const messages = await messagesRepository.getMessagesForContact(
        contactId,
        CONTEXT_MESSAGE_LIMIT,
        false
      );
      const startedMessageId = Number(lead.started_message_id);
      const journeyMessages = Number.isSafeInteger(startedMessageId) && startedMessageId > 0
        ? messages.filter((message) => Number(message.id) >= startedMessageId)
        : messages;
      const currentIndex = journeyMessages.findIndex(
        (message) => Number(message.id) === Number(messageId)
      );
      const messagesBeforeCurrent = journeyMessages.slice(
        0,
        currentIndex < 0 ? journeyMessages.length : currentIndex
      );
      const previousMessage = messagesBeforeCurrent.at(-1);
      const previousClinicMessage = previousMessage?.role === "assistant"
        ? previousMessage.content
        : "";

      classification = classifyTemperatureMessage({
        messageText,
        previousClinicMessage,
        branchNames,
      });
    }

    if (!classification) {
      return { status: "unchanged" };
    }

    const updatedLead = await pipelineRepository.applyRuleBasedTemperature(
      lead.id,
      classification
    );
    return updatedLead
      ? { status: "updated", lead: updatedLead, classification }
      : { status: "skipped", reason: "lead-changed", classification };
  };
}

const reviewLeadTemperatureForMessage = createLeadTemperatureReviewer({
  pipelineRepository: pipelineRepo,
  messagesRepository: messagesRepo,
  getBranchNames: () => (clinicConfig.branches || []).map((branch) => branch.name),
});

module.exports = {
  classifyTemperatureMessage,
  createLeadTemperatureReviewer,
  reviewLeadTemperatureForMessage,
};
