const { isGreetingOrLanguageOnly } = require("./chatLanguage");
const { withoutExplicitMarketingRefusal } = require("./marketingRefusal");

// Independent evidence from the CURRENT customer text. A model flag or Meta
// attribution is not enough to send unsolicited promotions/result images.
const PRICE_OR_PACKAGE = /(?:\b(?:price|pricing|cost|fees?|charges?|rate|rates|promo(?:tion)?s?|discounts?|vouchers?|rm\s*\d{2,})\b|\b(?:harga|promosi|diskaun|baucar|tawaran|ringgit|bayaran|kos|caj)\b|价[格錢钱]|費用|费用|收[费費]|多少[钱錢]|优惠|優惠|折扣|促销|促銷|\b(?:(?:special|current|any|what|which)\s+offers?)\b)/iu;


// Naming a package is treatment interest, not by itself a request for its
// price or promotional graphics. A question about *which options exist* is different.
// Requests for a single package's details, composition or procedure remain
// service enquiries, even if the customer says "send" or "show me".
const PACKAGE_OPTIONS_REQUEST = /(?:\b(?:do\s+you\s+have\s+(?:any\s+)?(?:a\s+)?packages?|(?:what|which|any|show\s+me|list(?:\s+me)?|send\s+me)\b.{0,35}\bpackages\b)(?!\s+(?:details?|information|description|contents?|explanation))|\bpackages?\s+(?:available|options?)\b|(?:^|[,，。;；\n])\s*package\s+[abc]\s*(?:[?？]|$)|(?:有(?:什么|什麼|哪些|没有|沒有)|哪(?:些|种|種)|列出).{0,20}(?:配套|套餐|pakej|packages?)|(?:配套|套餐|pakej).{0,15}(?:有哪[些种種]|有哪些|选项|選項|清单|清單|列表)|(?:发我|發我|发给我|發給我|给我看|給我看).{0,20}(?:配套|套餐)(?:选项|選項|清单|清單|列表)|\b(?:apa|ada|senarai|pilihan)\b.{0,25}\bpakej\b|\bpakej\b.{0,20}\b(?:apa|ada|pilihan)\b|\b(?:packages?|pakej)\s+(?:apa|yang\s+mana|ada)\b)/iu;

// "How much" can be a price enquiry or a question about time, discomfort,
// frequency, quantity and recovery. Only unambiguous usages count as price
// evidence, unless the message separately contains an explicit money term.
const ENGLISH_MONEY_QUESTION = /\bhow\s+much\b(?!\s+(?:time|long(?:er)?|duration|recovery|rest|downtime|pain|discomfort|swelling|water|weight|pressure|effort|sleep|exercise|work|energy|space|area|difference|improvement|notice|healing|waiting|treatment\s+time)\b|\s+(?:is|are|was|were)\s+(?:(?:the|my|your|a|an|this)\s+)?(?:recovery|healing|waiting|rest|downtime|treatment|appointment|procedure)\s+(?:time|duration|period)\b|\s+(?:does|do|did|will|would|should|can|could|must|need)\b[^?.!,;]{0,85}\b(?:take|last|hurt|heal|recover|rest|sleep|wait|waiting)\b)/iu;

const MALAY_MONEY_QUESTION = /(?:\bberapa\s+(?:(?:harga|bayaran|kos|caj|rm|ringgit)\b|(?:yang\s+)?(?:perlu\s+)?bayar\b|untuk\b)|\b(?:rm|ringgit)\s+berapa\b)/iu;
const MALAY_NON_PRICE_QUANTITY = /\bberapa\s+(?:lama|masa|hari|minggu|bulan|kali|sesi|jam|minit|orang|tahun|umur|kerap|banyak\s+sesi)\b/iu;
// Malaysian colloquial price requests are not generic treatment or package
// enquiries. "几钱" is different from "几次" or "几多疗程".
// Bare "几多" is ambiguous and must not make a session-count question a price request.
const LOCAL_MONETARY_QUESTION = /(?:几\s*[钱錢]|幾\s*[钱錢]|几\s*多\s*[钱錢]|幾\s*多\s*[钱錢]|多\s*[少幾几]\s*(?:块|塊|令吉)|(?:几|幾)\s*(?:块|塊)(?:钱|錢)?|(?:价\s*位|價\s*位)(?=\s*(?:[?？]|多少|如何|怎么|怎麼|什么|什麼|几|幾|$))|(?:(?:price|harga|kos|caj|rate|fee|rm)\s*(?:please|pls|plz|berapa|brp)|(?:pm|p\.?m\.?)\s*(?:(?:一下|下|我|me)\s*)?(?:价格|價錢|价钱|价位|價位|几钱|幾錢|harga|price)))/iu;

// Malaysian Chinese WhatsApp users often omit 钱/price in shorthand such as
// "3D 做一次要多少", "现在什么价", "first trial 几多", "RM几多",
// or ask for a "quote". Be narrow: bare 多少/几多 alone must NOT unlock
// prices or optional sales graphics; nor can duration/session-count questions.
// The downstream service authority still requires a customer-verified treatment.
const LOCAL_WHATSAPP_PRICE = new RegExp([
  String.raw`(?:什么|什麼|啥)\s*(?:价|價)(?:钱|錢|格|位)?`,
  String.raw`|(?:报|報)\s*价`,
  String.raw`|\b(?:quote|quotation)\b\s*(?:me\b|我|一下|给我|給我|[?？])`,
  String.raw`|\b(?:can|could|may|please|pls|send|give|share|need|want)\b.{0,35}\b(?:quote|quotation)\b`,
  String.raw`|\b(?:rm|myr)\s*(?:几|幾)\s*(?:多(?:钱|錢)?|钱|錢|块|塊)`,
  String.raw`|(?:几|幾)\s*多\s*(?:rm|myr)\b`,
  String.raw`|(?:价|價)\s*(?:是|要|大概|约|約)?\s*(?:多少|几多|幾多)(?=[\s?？!！。呢啊呀啦哦咯~]*$|[，,;；])`,
  String.raw`|(?:做\s*)?(?:一|1)\s*(?:次|回|趟|(?:个|個)?\s*(?:session|set))\s*(?:要|需|需要|花|收|收费|收費|算|是|大概|大约|大約)?\s*(?:多少|几多|幾多)(?=[\s?？!！。呢啊呀啦哦咯~]*$|[，,;；])`,
  String.raw`|(?:first[\s-]*trial|首次|初次|第一次)\s*(?:体验|體驗|护理|護理|疗程|療程)?\s*(?:要|需|需要|花|收|收费|收費|算|是|大概|大约|大約)?\s*(?:多少|几多|幾多)(?=[\s?？!！。呢啊呀啦哦咯~]*$|[，,;；])`,
  String.raw`|\b[39]\s*d\b\s*(?:这个|這個)?\s*(?:要|收|大概|大约|大約)?\s*(?:几多|幾多)(?=[\s?？!！。呢啊呀啦哦咯~]*$|[，,;；])`,
  String.raw`|\b(?:brp|brapa)\s*(?:rm|myr|harga|kos)\b`,
].join(""), "iu");

// The generic word "berapa" means "how many/how much", not necessarily price.
const ADMIN_TOPIC = /(?:\b(?:contact(?:\s+(?:details?|information|info|number))?|phone(?:\s+number)?|tel(?:ephone)?|mobile(?:\s+number)?|whatsapp(?:\s+number)?|e-?mail|address|location|branches?|opening\s+(?:hours?|times?)|operating\s+hours?|working\s+hours?|business\s+hours?|parking|directions?|google\s+maps?|postal\s+code|opening\s+day|closing\s+time|appointment\s+(?:slots?|time|availability)|payment\s+method|payment\s+options?)\b|联络方式|聯絡方式|联系方式|聯繫方式|电话号码|電話號碼|电话|電話|地址|在哪里|在哪裡|营业时间|營業時間|几点开门|幾點開門|停车|停車|分行|分店|怎么去|怎麼去|停车位|停車位|\b(?:nombor\s+(?:telefon|whatsapp)|telefon|hubungi|alamat|lokasi|cawangan|waktu\s+operasi|tempat\s+letak\s+kereta|parking)\b)/iu;

// Admin context alone is not a treatment request. An explicit service question
// can still ask two things (e.g. "3D treatment and your opening hours").
const SPECIFIC_TREATMENT_TOPIC = /(?:\b(?:treatments?|rawatan|facial|pelvic|pelvis|postpartum|hifu|jawline|acne)\b|\b[39]\s*d\b|疗程|療程|治疗|治療|骨盆|整骨|小颜|小顏|逆龄|逆齡|调理|調理|脸型|臉型|双下巴|雙下巴|下颚|下顎|法令纹|法令紋)/iu;

const DECLINED_TREATMENT = /(?:\b(?:not\s+interested|no\s+interest|don['’]?t\s+want|do\s+not\s+want|not\s+looking\s+for)\b|不感兴趣|不感興趣|不想了解|不想做|不要这个|不要這個|没兴趣|沒興趣|tak\s+(?:berminat|mahu|nak))/iu;

const DECLINED_PRICE = /(?:\b(?:no|not|don['’]?t|do\s+not)\s+(?:need|want|ask(?:ing)?\s+for)\s+(?:the\s+)?(?:price|pricing|package|promo)\b|(?:不[想要需]|不用|无需|不必)(?:知道|了解|问|問)?(?:价格|價錢|价钱|配套|套餐))/iu;

// Positive treatment-interest language, independent of Meta and AI labels.
// Keep this deliberately conservative: absent evidence means no automatic media.
const SERVICE_ENQUIRY = /(?:\b(?:interested|enquir(?:y|e)|inquir(?:y|e)|information|details?|tell\s+me\s+more|learn\s+more|know\s+more|find\s+out|want\s+to\s+(?:know|try|do|improve|treat)|would\s+like\s+to\s+(?:know|try|do|improve|treat)|can\s+(?:i|you)\s+(?:try|do|know|see|improve|treat)|how\s+(?:does|do|can|long)|what\s+(?:is|are|does|results?|benefits?|treatment)|does\s+(?:it|this)|results?|before\s*(?:and|&)\s*after|pelvic|pelvis|postpartum|facial|jawline|double\s+chin|treatment)\b|\b(?:nak\s+(?:tahu|cuba|buat|rawatan)|mahu\s+(?:tahu|cuba|buat)|berminat|rawatan|hasil|kesan|boleh\s+(?:ke|tahu))\b|想了解|想知道|想咨询|想諮詢|想问|想問|想做|感兴趣|感興趣|可以改善|怎么做|怎麼做|如何做|怎么改善|怎麼改善|有什么效果|有什麼效果|有效吗|有效嗎|案例|效果|整骨|骨盆|小腹|产后|產後|脸型|臉型|下颚|下顎|双下巴|雙下巴|皮肤松弛|皮膚鬆弛|小颜|小顏|逆龄|逆齡|\b[39]\s*d\b)/iu;

// A contextual enquiry ("more info on this") refers to an ad but does not
// identify a treatment on its own. Callers must separately verify the current
// Meta creative names exactly one configured service before using this signal
// to select automatic before/after media.
const CONTEXTUAL_AD_ENQUIRIES = [
  /^(?:can|could|may)\s+i\s+(?:(?:get|have)\s+(?:(?:some|a\s+bit\s+of)\s+)?(?:more\s+)?(?:info(?:rmation)?|details?)|(?:know|learn)\s+more)\s+(?:on|about|regarding)\s+(?:this|it|the\s+(?:ad|offer|treatment))$/iu,
  /^(?:(?:can|could)\s+you\s+)?tell\s+me\s+more(?:\s+about\s+(?:this|it))?$/iu,
  /^i(?:'d|\s+would)\s+like\s+to\s+(?:know|learn)\s+more(?:\s+about\s+(?:this|it))?$/iu,
  /^i(?:'m|\s+am)\s+interested(?:\s+in\s+(?:this|it))?$/iu,
  /^more\s+(?:info(?:rmation)?|details?)\s+(?:please|about\s+(?:this|it))$/iu,
  /^(?:可以(?:了解|知道|介绍|介紹)(?:一下|更多)?(?:这个|這個|这项|這項|疗程|療程)?[吗嗎]?|想(?:了解|知道)(?:一下|更多)?(?:这个|這個|这项|這項)(?:疗程|療程)?)$/iu,
  /^(?:(?:boleh\s+(?:tahu|share)|nak\s+tahu|mahu\s+tahu)\s+(?:(?:lebih\s+)?lanjut\s+)?(?:tentang\s+)?(?:ini|rawatan\s+ini))$/iu,
];

function isContextualAdServiceEnquiry(customerText) {
  const raw = String(customerText || "").trim();
  if (!raw || raw.length > 180 || DECLINED_TREATMENT.test(raw) ||
      ADMIN_TOPIC.test(raw) || hasCustomerPriceEnquiry(raw)) return false;
  const text = raw
    .replace(/^(?:(?:(?:hello|hi|hey)\b|你好|嗨|哈咯)[\s,，.!！。~]*)+/iu, "")
    .replace(/[\s.!?？！。~]+$/u, "")
    .trim();
  return CONTEXTUAL_AD_ENQUIRIES.some((pattern) => pattern.test(text));
}

// An invitation to send FUTURE offers is not an immediate price enquiry.
// Strip only the future-contact clauses and preserve treatment interest or
// any separately stated current package/price question.
const FOLLOW_UP_PERMISSION = /(?:可以|愿意|願意|同意|希望|请|請).{0,35}(?:跟[进進]我|联系我|聯繫我|whats\s*app\s*(?:跟[进進]|联系|聯繫|通知)|收(?:到|取).{0,20}(?:跟[进進]|优惠|優惠))|\b(?:i(?:'d| would)?\s+(?:also\s+)?(?:like|want)\s+to\s+receive|feel\s+free\s+to|you\s+can|please)\b.{0,110}\b(?:follow[\s-]?ups?|whats\s*app|updates?)\b|\b(?:boleh|sila|saya\s+(?:nak|mahu|setuju|bersetuju)).{0,80}(?:whats\s*app|susulan|hubungi)\b/iu;
const RELATED_OFFERS = /(?:优惠|優惠|促销|促銷|\b(?:offers?|promos?|promotions?|deals?|discounts?|promosi|tawaran)\b)/iu;
const FUTURE_OFFER_NOTIFICATION = /(?:有(?:相关|相關|最新|新|其他)?(?:的)?(?:优惠|優惠|促销|促銷).{0,32}(?:发|發|通知|告诉|告訴)|(?:之后|之後|以后|以後|后续|後續|将来|將來).{0,45}(?:优惠|優惠|promos?|promotions?|offers?).{0,40}(?:通知|发|發|send|whats\s*app)|(?:优惠|優惠|促销|促銷).{0,28}(?:可以|请|請).{0,25}(?:发|發|通知))/iu;
const REFUSED_FOLLOW_UP = /(?:不\s*可以|不\s*要|不\s*想|不\s*用|不\s*愿意|不\s*願意|不\s*同意|不希望|不接受|不方便|不能|别|別|請勿|请勿|暂时不要|暫時不要).{0,20}(?:跟[进進]|联系|聯繫|whats\s*app|发|發|通知)|(?:don't|do\s+not|stop|unsubscribe|no\s+follow[\s-]?ups?|not\s+agree|jangan|tak\s+nak|tidak\s+mahu).{0,50}(?:follow[\s-]?ups?|whats\s*app|messages?|promotions?|offers?|susulan|promosi)/iu;
// A refusal of future contact or marketing is not a price enquiry.
// Do not let a separate optimistic "offers can be sent" phrase reverse it.
const REFUSED_PROMOTION = /(?:不\s*(?:希望|接受|方便|愿意|願意|想|要|需要|可以)|拒收|拒绝|別|别|请勿|請勿).{0,45}(?:优惠|優惠|促销|促銷|广告|廣告|营销|營銷|推广|推廣|\b(?:whats\s*app|offers?|promos?|promotions?|marketing)\b)|(?:don't|do\s+not|no\s+more|unsubscribe|opt\s*out|not\s+interested).{0,65}\b(?:offers?|promos?|promotions?|marketing|messages?|whats\s*app)\b/iu;
const DIRECT_RESULT_REQUEST = /(?:前[后後]对比|前[后後]對比|(?:效果|对比|對比)[图圖]|案例[图圖照片]|\bbefore[\s&/-]*(?:and[\s-]*)?after\b)/iu;
const DIRECT_CURRENT_REQUEST = /(?:\b(?:how\s+much|what(?:'s| is)?\s+(?:the\s+)?(?:price|cost)|send\s+(?:me\s+)?(?:the\s+)?(?:price|packages?|offers?)|show\s+me\s+(?:the\s+)?(?:packages?|offers?|promotions?)|(?:what|which)\s+(?:packages?|offers?|promotions?)|right\s+now|today)\b|(?:现在|現在|马上|馬上|立即).{0,24}(?:多少[钱錢]|价[格钱錢]|價錢|优惠|優惠|配套|套餐)|(?:有(?:什么|什麼)|什么|什麼|哪些|哪种|哪種)(?:优惠|優惠|配套|套餐)|(?:优惠|優惠|促销|促銷|配套|套餐).{0,18}(?:现在|現在|马上|馬上|立刻|立即|直接|先).{0,15}(?:发|發|给|給|看|传|傳|send|通知)|(?:优惠|優惠)(?:是)?多少|(?:套餐|配套)(?:有哪些|有哪[些种種]|是什[么麼]|详情|詳情)|(?:想知道|想看|给我|給我|发我|發我|介绍|介紹|查看|看看).{0,18}(?:优惠详情|優惠詳情|优惠内容|優惠內容|配套(?:价格|價錢|详情|詳情)|套餐(?:价格|價錢|详情|詳情)))/iu;

function stripFutureFollowUpPermission(customerText) {
  const original = String(customerText || "").normalize("NFKC").trim();
  if (!original || original.length > 2000 || !RELATED_OFFERS.test(original)) {
    return { text: original, hasFuturePermission: false };
  }
  const clauses = original.split(/[，,。.!！;；\n]+/u).map((part) => part.trim()).filter(Boolean);
  const denied = clauses.some((part) =>
    REFUSED_FOLLOW_UP.test(part) || REFUSED_PROMOTION.test(part)
  );
  const affirmative = clauses.some((part) =>
    FOLLOW_UP_PERMISSION.test(part) && !REFUSED_FOLLOW_UP.test(part) &&
    !REFUSED_PROMOTION.test(part)
  );
  const standaloneFutureOffer = clauses.some((part) =>
    FUTURE_OFFER_NOTIFICATION.test(part) &&
    /(?:之后|之後|以后|以後|后续|後續|将来|將來)/u.test(part) &&
    !REFUSED_FOLLOW_UP.test(part) && !REFUSED_PROMOTION.test(part)
  );
  if (denied || (!affirmative && !standaloneFutureOffer)) {
    // Refusal takes priority across the entire message. Keep any separate
    // direct price request, but never mistake the refusal or remaining
    // future-offer notification for a request to send media immediately.
    const kept = clauses.filter((part) => {
      if (DIRECT_CURRENT_REQUEST.test(part) &&
          !REFUSED_PROMOTION.test(part) && !REFUSED_FOLLOW_UP.test(part)) return true;
      return !REFUSED_FOLLOW_UP.test(part) &&
        !REFUSED_PROMOTION.test(part) &&
        !FUTURE_OFFER_NOTIFICATION.test(part) &&
        !FOLLOW_UP_PERMISSION.test(part);
    });
    return { text: kept.join("。"), hasFuturePermission: false };
  }
  const kept = clauses.filter((part) => {
    if (DIRECT_CURRENT_REQUEST.test(part)) return true;
    if (FOLLOW_UP_PERMISSION.test(part) || FUTURE_OFFER_NOTIFICATION.test(part)) return false;
    return true;
  });
  return { text: kept.join("。"), hasFuturePermission: true };
}

function hasFuturePromotionPermissionWithoutPrice(customerText) {
  const parsed = stripFutureFollowUpPermission(customerText);
  return parsed.hasFuturePermission &&
    !PRICE_OR_PACKAGE.test(parsed.text) &&
    !PACKAGE_OPTIONS_REQUEST.test(parsed.text) &&
    !ENGLISH_MONEY_QUESTION.test(parsed.text) &&
    !(MALAY_MONEY_QUESTION.test(parsed.text) && !MALAY_NON_PRICE_QUANTITY.test(parsed.text));
}

// Descriptive only: receiving future offers never blocks independently
// eligible service-level Before & After images.
function isFollowUpConsentEnquiry(customerText) {
  return hasFuturePromotionPermissionWithoutPrice(customerText) &&
    !DIRECT_RESULT_REQUEST.test(String(customerText || ""));
}

const ACK_ONLY = /^(?:ok(?:ay)?|kk|k|alright|all\s+right|noted|thanks?(?:\s+you)?|thank\s+you|tq|thx|sure|yes|yeah|yep|no|nope|later|fine|got\s+it|received|好的|好|好吧|谢谢|謝謝|收到|明白|嗯|哦|是的|可以|好呀|baik|terima\s+kasih|faham|boleh|ya|tak|👍|🙏|😊|🙂)[\s.!！。~👍🙏😊🙂]*$/iu;
const ADMIN_ONLY = /^(?:(?:where\s+(?:are|is)|what\s+(?:are|is)\s+(?:your|the)|can\s+you\s+(?:give|send)\s+(?:me\s+)?)\s*)?(?:address|location|branch(?:es)?|business\s+hours?|opening\s+hours?|contact|phone\s+number|whatsapp|opening\s+time|clinic\s+location|appointment\s+slots?|营业时间|營業時間|分店|地址|电话号码|電話號碼|在哪里|在哪裡|营业吗|營業嗎|lokasi|alamat|cawangan|waktu\s+operasi)(?:[\s?？!.。]*)$/iu;

// A model packageQuery flag alone is not authorization to send an offer.
// Require positive option-list evidence in the customer's own CURRENT text.
function hasExplicitPackageOptionsRequest(customerText) {
  const current = String(customerText || "").trim();
  return PACKAGE_OPTIONS_REQUEST.test(current) ||
    /(?:有(?:什么|什麼|哪些|没有|沒有).{0,16}(?:优惠|優惠|促销|促銷)|(?:哪些|什么|什麼)(?:优惠|優惠|促销|促銷)|(?:优惠|優惠|促销|促銷).{0,12}(?:有哪些|有什[么麼]|有哪[些种種])|\b(?:what|which|any|show|list|available|have)\b.{0,30}\b(?:offers?|promos?|promotions?|deals?)\b|\b(?:ada|apa|senarai|pilihan)\b.{0,25}\b(?:promosi|tawaran)\b)/iu.test(current);
}

function hasCustomerPriceEnquiry(customerText) {
  const value = String(customerText || "").trim();
  if (!value || isGreetingOrLanguageOnly(value) || ACK_ONLY.test(value)) return false;
  // Declining one treatment must not suppress a separate, explicit CURRENT
  // pricing question about another treatment in the same customer message.
  // A standalone refusal still does not authorize promotional images.
  if (DECLINED_PRICE.test(value)) return false;
  if (DECLINED_TREATMENT.test(value) &&
      !DIRECT_CURRENT_REQUEST.test(value) &&
      !/(?:多少[钱錢]|价格(?:是)?多少|價錢(?:是)?多少|价钱(?:是)?多少|\bhow\s+much\b)/iu.test(value)) {
    return false;
  }
  // A refusal to receive promotions is not an invitation to show their
  // graphics. Strip only the refusal wording; preserve an independent,
  // explicit price question if the customer separately asks one.
  const current = withoutExplicitMarketingRefusal(
    stripFutureFollowUpPermission(value).text
  );
  return PRICE_OR_PACKAGE.test(current) ||
    LOCAL_MONETARY_QUESTION.test(current) || LOCAL_WHATSAPP_PRICE.test(current) ||
    PACKAGE_OPTIONS_REQUEST.test(current) ||
    ENGLISH_MONEY_QUESTION.test(current) ||
    (MALAY_MONEY_QUESTION.test(current) && !MALAY_NON_PRICE_QUANTITY.test(current));
}

// A specific monetary treatment-price question is narrower than asking
// whether offers/packages exist or consenting to future promotional updates.
// A first-trial amount question can omit the word "price": e.g.
// "请问首次体验是多少呢". Require the monetary "多少" form so that
// questions about session duration, results or treatment suitability do not
// accidentally authorize a sales quote or picture.
function isFirstTrialAmountQuestion(customerText) {
  const text = String(customerText || "").normalize("NFKC").trim();
  return text.length <= 80 &&
    /(?:首次|初次|第一次)\s*(?:体验|體驗|护理|護理|疗程|療程)?\s*(?:的|是|要|收费|收費|费用|費用|价[格钱錢]|價格|大概|大约|大約|需要)?\s*(?:多少(?:钱|錢)?|几多(?:钱|錢)?|幾多(?:钱|錢)?)(?:呢|啊|呀|吗|嗎)?[\s?？。!！]*$/iu.test(text) &&
    !/(?:多久|多长|多長|几次|幾次|多[久长長]|几[分钟鐘]|幾[分钟鐘]|几小时|幾小時)/iu.test(text);
}

function isStandalonePriceQuestion(customerText) {
  const t = String(customerText || "").normalize("NFKC").trim();
  return /^(?:现在|現在|请问|請問|nak\s+tahu\s+)?\s*(?:多少钱|多少錢|几多钱|幾多錢|几钱|幾錢|价钱|價錢|价格|價[格位]|how\s+much|price|harga|berapa|brapa|brp|berapa\s+ya)[\s?.!！。？]*$/iu.test(t);
    // A short session-amount question may refer to an already independently
    // confirmed treatment. The context resolver enforces freshness and ownership.
    || /^(?:(?:请问|請問|这个|這個|这项|這項|那个|那個)\s*)?(?:做\s*)?(?:一|1)\s*(?:次|回|趟|(?:个|個)?\s*(?:session|set))\s*(?:要|需|需要|花|收|收费|收費|算|是|大概|大约|大約)?\s*(?:多少|几多|幾多)[\s?？!！。呢啊呀啦哦咯~]*$/iu.test(t);
}

function isContextualBarePriceQuestion(customerText, treatment = null) {
  return Boolean(String(treatment || "").trim()) &&
    /^(?:berapa|brp|brapa|berapa\s+ya|berapa\s+eh)[\s?.!！。？]*$/iu.test(
      String(customerText || "").normalize("NFKC").trim()
    );
}

function hasExplicitPriceRequest(customerText, { treatment = null } = {}) {
  const original = String(customerText || "").trim();
  if (!original || isGreetingOrLanguageOnly(original)) return false;
  const current = withoutExplicitMarketingRefusal(
    stripFutureFollowUpPermission(original).text
  ).normalize("NFKC").trim().replace(
    /(?:\b(?:RM|MYR)\s*100\s*(?:voucher|coupon|discount|off|baucar)|(?:优惠券|優惠券|抵用券|baucar|voucher|coupon)\s*(?:RM|MYR)\s*100|(?:RM|MYR)\s*100\s*(?:优惠券|優惠券|抵用券))/giu,
    "[VOUCHER]"
  );
  if (!current) return false;
  if (isContextualBarePriceQuestion(current, treatment)) return true;
  // A customer refusing to discuss prices is not making a price request.
  const declined = /(?:不用|不要|不想|无需|無需|别|別).{0,20}(?:价格|價錢|价钱|费用|費用)|\b(?:don't|do not|not|no)\b.{0,35}\b(?:price|pricing|cost)\b/iu.test(current);
  if (declined && !/(?:多少钱|多少錢|几多钱|幾多錢|how\s+much|(?:请问|請問|what(?:'s| is)).{0,20}(?:price|cost|价格|价钱|價錢))/iu.test(current)) return false;
  // Mentioning a budget or saying prices are acceptable is not a request
  // for the clinic's actual treatment price. These statements used to bypass
  // the final no-unsolicited-prices check just because they contained RM/价钱.
  const nonRequest = /(?:\b(?:my|our)\s+budget\b|\bbudget\s*(?:is|around|about|of|rm)\b|预算|預算|比较在意|比較在意|担心|擔心|不在意|不介意|无所谓|無所謂|没关系|沒關係).{0,40}(?:价格|價錢|价钱|费用|費用|\b(?:price|pricing|cost|rm\s*\d+|myr\s*\d+)\b)|(?:价格|價錢|价钱|费用|費用|\b(?:price|pricing|cost)\b).{0,20}(?:不是问题|不是問題|不重要|不介意|无所谓|無所謂|太贵|太貴|太高|acceptable|not\s+an?\s+issue|not\s+important|doesn['’]?t\s+matter)/iu.test(current);
  // A price adjective or affordability observation does not request another
  // quotation/graphic. A separate explicit question still takes precedence.
  const affordabilityOnly = /(?:价位|價位|价格|價格|价钱|價錢|\b(?:price|pricing|harga)\b).{0,30}(?:太高|偏高|太贵|太貴|好贵|好貴|有点贵|有點貴|很贵|很貴|贵了|貴了|超出预算|超出預算|too\s+(?:high|expensive)|expensive|mahal)|(?:超出预算|超出預算|负担不起|負擔不起|cannot\s+afford|can't\s+afford).{0,28}(?:价位|價位|价格|價格|价钱|價錢|\b(?:price|pricing|harga)\b)/iu.test(current);
  const clearRequest = LOCAL_MONETARY_QUESTION.test(current) || LOCAL_WHATSAPP_PRICE.test(current) || /(?:多少钱|多少錢|几多钱|幾多錢|\bhow\s+much\b|\bberapa\s+(?:harga|nak\s+bayar|bayar|untuk)\b|(?:请问|請問|想知道|想了解|告诉我|告訴我|可以告诉|可以告訴|\b(?:what|tell|send|share|show|could|can|may|please|nak\s+tahu|boleh\s+tahu)\b).{0,45}(?:价格|價錢|价钱|費用|费用|\b(?:price|pricing|cost|fees?|harga|rates?)\b))/iu.test(current);
  if ((nonRequest || affordabilityOnly) && !clearRequest) return false;
  // A money amount given as the customer's own budget does not ask what our
  // treatment costs. Bare RM amounts need a question/request to qualify.
  if (/\b(?:RM|MYR)\s*\d{2,}/iu.test(current) &&
      !/[?？]/u.test(current) && !clearRequest &&
      !/(?:多少钱|多少錢|几多钱|幾多錢)/u.test(current) &&
      !/(?:价格|價錢|价钱|\b(?:price|pricing|cost|fee|harga)\b)/iu.test(current)) return false;
  // "How much time/recovery" asks for a duration, not a treatment price.
  if (/\bhow\s+much\b/iu.test(current) &&
      !ENGLISH_MONEY_QUESTION.test(current) &&
      !/(?:价格|價錢|价钱|費用|费用|\b(?:price|pricing|cost|fee|rm\s*\d+)\b)/iu.test(current)) return false;
  return isFirstTrialAmountQuestion(current) || LOCAL_MONETARY_QUESTION.test(current) || LOCAL_WHATSAPP_PRICE.test(current) || /(?:价[格钱錢]|價錢|費用|费用|收[费費]|多少[钱錢]|几多钱|幾多錢|(?:配套|套餐).{0,12}(?:几钱|幾錢|多少钱|多少錢)|\b(?:price|pricing|cost|fees?|charges?|rates?|how\s+much|harga|bayaran|berapa\s+(?:harga|bayar|ringgit|rm|kos|caj)|rm\s*\d{2,}|myr\s*\d{2,})\b)/iu.test(current);
}

function hasCustomerServiceEnquiry(customerText) {
  const value = String(customerText || "").trim();
  if (!value || isGreetingOrLanguageOnly(value) || ACK_ONLY.test(value)) return false;
  if (DECLINED_TREATMENT.test(value)) return false;
  if ((ADMIN_ONLY.test(value) || ADMIN_TOPIC.test(value)) &&
      !SPECIFIC_TREATMENT_TOPIC.test(value) &&
      !hasCustomerPriceEnquiry(value)) return false;
  return hasCustomerPriceEnquiry(value) || SERVICE_ENQUIRY.test(value);
}

module.exports = { isFirstTrialAmountQuestion, LOCAL_MONETARY_QUESTION, isStandalonePriceQuestion, isContextualBarePriceQuestion, hasExplicitPriceRequest, hasCustomerPriceEnquiry, hasExplicitPackageOptionsRequest, hasCustomerServiceEnquiry, isContextualAdServiceEnquiry, isFollowUpConsentEnquiry, hasFuturePromotionPermissionWithoutPrice, stripFutureFollowUpPermission };
