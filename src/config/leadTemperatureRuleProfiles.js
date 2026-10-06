const { normalizeBusinessType } = require("./industryProfiles");

function frozenPatterns(patterns) {
  return Object.freeze(patterns);
}

const UNIVERSAL_ABSOLUTE_REJECTION_PATTERNS = frozenPatterns([
  /\b(?:wrong number|wrong person|you have the wrong (?:number|person))\b/,
  /\b(?:stop|don't|do not)\s+(?:message|messaging|text(?:ing)?|contact(?:ing)?|call(?:ing)?)\s+me\b/,
  /\b(?:remove|unsubscribe)\s+me\b/,
  /\b(?:salah nombor|salah orang)\b/,
  /\b(?:jangan|usah)\s+(?:mesej|hubungi|telefon|call)\s+(?:saya|aku)\b/,
  /(?:号码错了|打错了|找错人了|不是本人|别再联系|不要再联系|别发信息|不要发信息)/,
]);

const CLINIC_ABSOLUTE_REJECTION_PATTERNS = frozenPatterns([
  ...UNIVERSAL_ABSOLUTE_REJECTION_PATTERNS,
  /\b(?:i|we)(?:'ve| have)?\s+(?:already\s+)?(?:booked|chosen|gone with|decided on|found)\s+(?:another|a different)\s+(?:clinic|centre|center|provider|treatment provider)\b/,
  /\b(?:i|we)(?:'ve| have)?\s+(?:already\s+)?(?:done|had|completed)\s+(?:it|this|the treatment)\s+(?:at|with)\s+(?:another|a different)\s+(?:clinic|centre|center|provider)\b/,
  /^(?:(?:sorry|no thanks|no thank you|thanks|thank you)[, ]*)?(?:i|we)(?:'m| are| am)?\s+(?:not|no longer)\s+interested(?:\s+anymore)?(?:[, ]*(?:thanks|thank you))?[.!? ]*$/,
  /^(?:sorry[, ]*)?(?:i|we)(?:'m| are| am)?\s+(?:not|no longer)\s+(?:proceeding|going ahead|moving forward)(?:\s+(?:anymore|with this))?(?:[, ]*(?:thanks|thank you))?[.!? ]*$/,
  /^(?:sorry[, ]*)?(?:i|we)\s+(?:changed my mind|don't want to proceed|do not want to proceed|won't proceed|will not proceed)(?:\s+anymore)?(?:[, ]*(?:thanks|thank you))?[.!? ]*$/,
  /^(?:i\s+)?(?:don't|do not|won't|will not)\s+(?:want\s+to\s+)?(?:book|come|visit|proceed|go ahead)(?:\s+(?:anymore|at all))?[.!? ]*$/,
  /^(?:i|we)\s+(?:won't|will not|don't want to|do not want to)\s+(?:proceed|go ahead)\s+with\s+(?:your|the)\s+(?:clinic|centre|center|service|services|business)[.!? ]*$/,
  /\b(?:too far|too expensive|over budget).{0,50}\b(?:i|we)?\s*(?:won't|will not|can't|cannot)\s+(?:proceed|book|come|visit|go ahead)\b/,
  /\b(?:saya|kami)\s+(?:dah|sudah)\s+(?:book|booking|pilih|jumpa)\s+(?:klinik|pusat|provider)\s+lain\b/,
  /\b(?:saya|kami)\s+(?:dah|sudah)\s+(?:buat|ambil)\s+(?:rawatan|treatment)\s+(?:di|dekat)\s+(?:klinik|tempat|pusat)\s+lain\b/,
  /^(?:maaf[, ]*)?(?:saya|kami)\s+(?:dah|sudah)?\s*(?:tak|tidak)\s+berminat(?:\s+lagi)?(?:[, ]*(?:terima kasih|thanks))?[.!? ]*$/,
  /^(?:maaf[, ]*)?(?:saya|kami)\s+(?:tak|tidak)\s+(?:nak|mahu|akan)\s+(?:teruskan|proceed|book|booking|datang)(?:\s+lagi)?(?:[, ]*(?:terima kasih|thanks))?[.!? ]*$/,
  /(?:我|我们|我們)(?:已经|已經)(?:预约了|預約了|选了|選了|决定去|決定去|找到)(?:别的|別的|其他)(?:诊所|診所|中心|机构|機構)/,
  /(?:我|我们|我們)(?:已经|已經)(?:在|去)(?:别家|別家|其他)(?:诊所|診所|中心|机构|機構)(?:做了|做过|做過)(?:这个|這個)?(?:疗程|療程|治疗|治療)?/,
  /^(?:我|我们|我們)?(?:已经|已經)?(?:没兴趣了|沒興趣了|不感兴趣了|不感興趣了|不考虑了|不考慮了)(?:[,，]?(?:谢谢|謝謝))?[。.!！ ]*$/,
  /^(?:我|我们|我們)?(?:不做了|不继续了|不繼續了|不去了|不预约了|不預約了|不要了)(?:[,，]?(?:谢谢|謝謝))?[。.!！ ]*$/,
]);

const CONFIRMATION_PATTERNS = frozenPatterns([
  /^(?:yes|yes please|okay|ok|sure|please|confirm|confirmed|that works|sounds good)[.! ]*$/,
  /^(?:ya|ya boleh|boleh|ok boleh|setuju|baik|confirm|sahkan)[.! ]*$/,
  /^(?:好|好的|可以|确认|確認|确定|確定|没问题|沒問題)[。.! ]*$/,
]);

const DATE_OR_TIME_PATTERNS = frozenPatterns([
  /\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this\s+(?:week|weekend)|next\s+week|weekend)\b/,
  /\b(?:hari ini|esok|lusa|isnin|selasa|rabu|khamis|jumaat|sabtu|ahad|minggu ini|minggu depan|hujung minggu)\b/,
  /(?:今天|明天|后天|後天|星期[一二三四五六日天]|周[一二三四五六日天]|週[一二三四五六日天]|这个周末|這個週末|下周|下週)/,
  /\b(?:[01]?\d|2[0-3])[:.][0-5]\d\s*(?:am|pm)?\b/,
  /\b(?:[1-9]|1[0-2])\s*(?:am|pm)\b/,
  /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/,
  /\d{1,2}(?:点|點|时|時)/,
]);

const ALTERNATIVE_SCHEDULING_PATTERNS = frozenPatterns([
  /(?:\b(?:but|however|instead)\b|[,.;])\s*(?:on\s+)?(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this\s+(?:week|weekend)|next\s+week|weekend|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|(?:[01]?\d|2[0-3])[:.]\d{2}\s*(?:am|pm)?|(?:[1-9]|1[0-2])\s*(?:am|pm))\b.{0,40}\b(?:works?(?:\s+for\s+me)?|is\s+(?:okay|ok|fine|better)|would\s+work|i\s+(?:can|could|prefer)|can\s+(?:come|visit)|available|free)\b/,
  /(?:\b(?:tapi|tetapi|sebaliknya)\b|[,.;])\s*(?:hari\s+)?(?:ini|esok|lusa|isnin|selasa|rabu|khamis|jumaat|sabtu|ahad|minggu\s+ini|minggu\s+depan|hujung\s+minggu|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|(?:[01]?\d|2[0-3])[:.]\d{2}\s*(?:am|pm)?|(?:[1-9]|1[0-2])\s*(?:am|pm))\b.{0,40}\b(?:boleh|sesuai|ok|okay|lapang|free|lebih\s+baik)\b/,
  /(?:但是|可是|不过|不過|[,，]|。)(?:今天|明天|后天|後天|星期[一二三四五六日天]|周[一二三四五六日天]|週[一二三四五六日天]|这个周末|這個週末|下周|下週|\d{1,2}(?:点|點|时|時)).{0,20}(?:可以|没问题|沒問題|方便|有空|比较好|比較好)/,
]);

const GENERIC_DECLINE_PATTERNS = frozenPatterns([
  /\b(?:i(?:'m| am)?\s+)?(?:not|no longer)\s+interested(?:\s+anymore)?(?:,?\s*(?:thanks?|thank you))?\s*[.!?]*$/,
  /\b(?:i\s+)?(?:don't|do not)\s+(?:want|need)\s+(?:this|it|that|your services?)\b/,
  /\bno\s+thanks?(?:\s+you)?\b/,
  /\b(?:not for me|i(?:'ll| will) pass)\b/,
  /\b(?:saya\s+)?(?:tak|tidak)\s+berminat(?:\s+lagi)?(?:,?\s*(?:terima kasih|thanks?))?\s*[.!?]*$/,
  /^(?:terima kasih,?\s*)?(?:saya\s+)?(?:tak|tidak)\s+nak(?:,?\s*(?:terima kasih|thanks?))?\s*[.!?]*$/,
  /^(?:我)?(?:不感兴趣|没兴趣|沒有興趣|没有兴趣|不要了|不需要了|不用了|谢谢不用了?|謝謝不用了?)(?:[,，]?(?:谢谢|謝謝))?[。.!！]*$/,
]);

const GENERIC_POSITIVE_CONTRAST_PATTERNS = frozenPatterns([
  /(?:\b(?:but|however|instead|tapi|tetapi)\b.*\b(?:interested|want|need|know more|how much|price|cost|nak|mahu|berminat|berapa|harga)\b|(?:但是|可是|不过|不過).*(?:想|要|有兴趣|有興趣|了解|多少钱|多少錢|价格|價格|价钱|價錢))/,
]);

const CLINIC_DECLINE_PATTERNS = frozenPatterns([
  /\b(?:i(?:'m| am)?\s+)?(?:not|no longer)\s+interested(?:\s+(?:anymore|in\s+(?:your\s+)?(?:service|services|treatment|treatments|clinic)))?(?:,?\s*(?:thanks?|thank you))?\s*[.!?]*$/,
  /\b(?:i\s+)?(?:don't|do not)\s+(?:want|need)\s+(?:the treatment|your services?|an?\s+appointment|to\s+(?:book|schedule|make an appointment))\b/,
  /\b(?:i\s+)?(?:don't|do not)\s+(?:want|plan|intend)\s+to\s+(?:come|visit|reserve)\b/,
  /\b(?:i(?:'m| am)?\s+)?(?:won't|will not|am not going to|not going to)\s+(?:book|schedule|make an appointment)\b/,
  /\b(?:i(?:'m| am)?\s+)?(?:won't|will not|am not going to|not going to)\s+(?:come|visit|reserve)\b/,
  /\b(?:i|we)(?:'m| are| am)?\s+(?:not|no longer)\s+(?:proceeding|going ahead|moving forward)(?:\s+with\s+(?:this|it|the treatment|the package|the promotion|your services?))?\b/,
  /\b(?:too far|too expensive|over budget).{0,50}\b(?:i|we)?\s*(?:won't|will not|can't|cannot|don't want to|do not want to)\s+(?:proceed|book|come|visit|go ahead)\b/,
  /\b(?:not for me|i(?:'ll| will) pass)\b/,
  /\b(?:saya\s+)?(?:tak|tidak)\s+berminat(?:\s+(?:lagi|dengan\s+(?:servis|rawatan)(?:\s+(?:ini|anda|awak))?))?(?:,?\s*(?:terima kasih|thanks?))?\s*[.!?]*$/,
  /\b(?:saya\s+)?(?:tak|tidak)\s+(?:nak|mahu)\s+(?:rawatan\s+ini|servis\s+(?:ini|anda)|book|booking|reserve|datang|visit|buat\s+(?:appointment|temujanji|janji temu))\b/,
  /\b(?:saya\s+)?(?:tak|tidak)\s+akan\s+(?:datang|visit|book|booking|reserve)\b/,
  /\b(?:saya|kami)\s+(?:tak|tidak)\s+(?:nak|mahu)\s+(?:teruskan|proceed)\s+(?:rawatan|treatment|package|pakej|promo|promosi|servis|service)?\s*(?:ini|itu)?\b/,
  /\b(?:saya\s+)?(?:tak|tidak)\s+(?:perlu|payah)(?:\s+(?:ini|itu|servis|rawatan))?(?:,?\s*(?:terima kasih|thanks?))?\s*[.!?]*$/,
  /^(?:terima kasih,?\s*)?(?:saya\s+)?(?:tak|tidak)\s+nak(?:,?\s*(?:terima kasih|thanks?))?\s*[.!?]*$/,
  /^(?:我)?(?:不感兴趣|没兴趣|沒有興趣|没有兴趣|不要了|不需要了|不用了|不做了|不继续了|不繼續了|不考虑了|不考慮了|谢谢不用了?|謝謝不用了?)(?:[,，]?(?:谢谢|謝謝))?[。.!！]*$/,
  /^(?:我)?(?:对|對)(?:你们|你們|这项|這項)?(?:服务|服務|疗程|療程)(?:不感兴趣|没兴趣|沒有興趣|没有兴趣)[。.!！]*$/,
  /^(?:我)?(?:不想|不要|不打算)(?:预约|預約|预订|預訂|订位|訂位|去你们|去你們|过去|過去|到店|来|來)(?:诊所|診所|门店|門店)?[。.!！]*$/,
]);

const CLINIC_POSITIVE_CONTRAST_PATTERNS = frozenPatterns([
  /(?:\b(?:but|however|instead|tapi|tetapi)\b.*\b(?:interested|want|need|book|appointment|know more|how much|price|cost|nak|mahu|berminat|berapa|harga)\b|(?:但是|可是|不过|不過).*(?:想|要|有兴趣|有興趣|了解|预约|預約|多少钱|多少錢|价格|價格|价钱|價錢))/,
]);

const CLINIC_UNCLEAR_HOT_PATTERNS = frozenPatterns([
  /\b(?:maybe|perhaps|not ready|not yet|still thinking|need to think|let me think|think about it|just (?:asking|checking|browsing)|maybe later|later on|not now|compare first|still comparing|(?:don't|do not) want to book (?:yet|now)|not booking (?:yet|now))\b/,
  /\bif\s+(?:i|we)\s+(?:decide|decided|want|wanted|choose|chose|am ready|are ready)\b.{0,70}\b(?:book|schedule|come|visit|buy|take|proceed|pay)\b/,
  /\b(?:just|only)\s+(?:asking|checking)\b.{0,70}\b(?:book|booking|appointment|reserve|payment|deposit)\b/,
  /\b(?:kalau|jika)\s+(?:saya|kami)\s+(?:nanti\s+)?(?:nak|mahu|dah bersedia|sudah bersedia|buat keputusan)\b.{0,60}\b(?:book|booking|datang|ambil|beli|teruskan|bayar)\b/,
  /(?:如果|要是)(?:我|我们|我們).{0,16}(?:以后|以後|之后|之後|到时|到時|决定|決定|想要).{0,30}(?:预约|預約|过去|過去|买|買|拿|继续|繼續|付款)/,
  /\bi\s+(?:may|might)\s+(?:want\s+to\s+)?(?:book|schedule|come|visit|buy|take|proceed)\b/,
  /\b(?:need|want)\s+to\s+(?:ask|check with)\s+(?:my\s+)?(?:husband|wife|partner|family)\s+first\b/,
  /\bif\b.{0,50}\b(?:discount|cheaper|lower price|better price|promo(?:tion)?|offer)\b.{0,50}\b(?:i|we)\s+(?:will|would|can|want to)\s+(?:buy|take|book|proceed|go ahead)\b/,
  /\b(?:kalau|jika)\b.{0,50}\b(?:discount|diskaun|murah|harga|promo|promosi)\b.{0,50}\b(?:saya|kami)\s+(?:akan|boleh|nak|mahu)\s+(?:ambil|beli|book|teruskan|proceed)\b/,
  /(?:如果|要是).{0,24}(?:折扣|优惠|優惠|便宜|价格|價格).{0,24}(?:我|我们|我們)(?:就|会|會|可以)?(?:要|买|買|拿|预约|預約|继续|繼續)/,
  /\b(?:do|would)\s+(?:i|we)\s+need\s+to\s+(?:pay\s+)?(?:a\s+)?deposit\b/,
  /\b(?:is|are)\s+(?:a\s+)?deposit\s+(?:required|needed)\b/,
  /\b(?:belum (?:bersedia|nak|mahu)|mungkin|masih fikir|nak fikir dulu|fikir dulu|tanya sahaja|tanya saja|survey dulu|nanti dulu|banding dulu|(?:tak nak|tidak mahu) book (?:dulu|lagi|sekarang))\b/,
  /\b(?:perlu|kena)\s+(?:saya|kami)?\s*(?:bayar\s+)?deposit\s*(?:ke|kah)?\b/,
  /(?:可能|也许|也許|还不想预约|還不想預約|暂时不预约|暫時不預約|还没决定|還沒決定|先看看|只是问问|只是問問|以后再说|以後再說|再考虑|再考慮|考虑一下|考慮一下|先问家人|先問家人|先比较|先比較|还在比较|還在比較|需要付定金吗|需要付定金嗎|要付定金吗|要付定金嗎)/,
  /\b(?:visit|check|open)\s+(?:your\s+)?(?:website|site|page|instagram|facebook)\b/,
]);

const CLINIC_WARM_INTEREST_PATTERNS = frozenPatterns([
  /\b(?:how much|what(?:'s| is) the price|price|pricing|cost)\b/,
  /\b(?:deposit|payment|instalment|installment)\b.{0,50}\b(?:need|required|how|can|pay|available|option|work)\b/,
  /\b(?:do|would)\s+(?:i|we)\s+need\s+to\s+(?:pay\s+)?(?:a\s+)?deposit\b/,
  /\b(?:is|are)\s+(?:a\s+)?deposit\s+(?:required|needed)\b/,
  /\b(?:is this|would this|is it)\s+(?:suitable|okay|ok|good|right)\s+for\s+me\b/,
  /\bhow\s+does\s+(?:this|it|the\s+(?:treatment|service|package))\s+work\b/,
  /\b(?:what|how)\b.{0,35}\b(?:result|results|effect|effects)\b/,
  /\b(?:promo(?:tion)?|discount|offer|package|treatment|service)\b.{0,60}\b(?:details?|info(?:rmation)?|price|cost|available|include|work|suitable)\b/,
  /\b(?:any|got|have any)\s+(?:promo(?:tion)?|discount|offer)s?\b/,
  /\b(?:what|which)\s+(?:treatments?|services?|packages?|promo(?:tion)?s?|options?)\b/,
  /\bdo you\s+(?:offer|provide|have)\b.{0,50}\b(?:treatment|service|package|promo(?:tion)?)s?\b/,
  /\b(?:tell me|can i know|could i know|want to know|would like to know)\b.{0,70}\b(?:more|price|package|treatment|service|promo(?:tion)?|branch|location)\b/,
  /\b(?:do you have|is there|where is|where are)\b.{0,50}\b(?:branch|clinic|centre|center|location)\b/,
  /\b(?:is|would)\b.{0,50}\b(?:treatment|service|package)\b.{0,30}\b(?:suitable|good|okay|ok|right)\b/,
  /\b(?:berapa\s+harga|harga\s+berapa)\b/,
  /\b(?:harga|promo|promosi|diskaun|pakej|rawatan)\b.{0,50}\b(?:berapa|detail|info|ada|boleh|macam mana|bagaimana|sesuai|include|termasuk)\b/,
  /^(?:promo|promosi|pakej|rawatan)[?!. ]*$/,
  /\b(?:deposit|bayaran|payment|ansuran|instalment)\b.{0,45}\b(?:perlu|kena|macam mana|boleh|ada)\b/,
  /\b(?:sesuai|okay|ok)\s+(?:tak|ke|kah)?\s*(?:untuk\s+saya)?\b/,
  /\b(?:macam mana|bagaimana)\s+(?:rawatan|treatment|pakej|ini)\s+(?:berfungsi|jalan|work)\b/,
  /\b(?:hasil|kesan)\b.{0,35}\b(?:macam mana|apa|boleh|nampak)\b/,
  /\b(?:boleh\s+tahu|nak\s+tahu|mahu\s+tahu)\b.{0,70}\b(?:lebih|harga|pakej|rawatan|promo|cawangan|lokasi)\b/,
  /\b(?:ada|kat mana|di mana)\b.{0,40}\b(?:cawangan|klinik|pusat|lokasi)\b/,
  /(?:多少钱|多少錢|价格|價格|价钱|價錢|优惠|優惠|分行|地址|在哪里|在哪裡|适合|適合|效果)/,
  /(?:配套|套餐|疗程|療程).{0,24}(?:多少钱|多少錢|价格|價格|价钱|價錢|详情|詳情|是什么|是什麼|适合|適合|效果|怎么|怎麼|如何)/,
  /^(?:配套|套餐|疗程|療程)[？?。.！! ]*$/,
  /(?:需要|要)(?:付|给|給)?(?:定金|订金|訂金)吗/,
  /(?:可以|能)(?:分期|付款|付定金)吗/,
  /(?:这个|這個|它)(?:适合|適合)我吗/,
  /(?:这个|這個|疗程|療程|配套|套餐)(?:怎么|怎麼|如何)(?:做|进行|進行|运作|運作)/,
  /(?:想了解|想知道|可以了解|可以知道).{0,30}(?:更多|价格|價格|价钱|價錢|配套|套餐|疗程|療程|优惠|優惠|分行)/,
]);

const CLINIC_WARM_COOLING_PATTERNS = frozenPatterns([
  /\b(?:not ready|not yet|still thinking|need to think|let me think|i(?:'ll| will) think|think about it|maybe later|later on|not now|compare first|still comparing)\b/,
  /\b(?:need|want)\s+to\s+(?:ask|check with)\s+(?:my\s+)?(?:husband|wife|partner|family)\s+first\b/,
  /\b(?:too expensive|over budget|too far|quite far|very far)\b.{0,70}\b(?:think|consider|compare|later|not now|maybe)\b/,
  /\bif\b.{0,50}\b(?:discount|cheaper|lower price|better price|promo(?:tion)?|offer)\b.{0,50}\b(?:i|we)\s+(?:will|would|can|want to)\s+(?:buy|take|book|proceed|go ahead)\b/,
  /\b(?:belum bersedia|belum ready|masih fikir|nak fikir dulu|mahu fikir dulu|fikir dulu|nanti dulu|banding dulu|masih banding)\b/,
  /\b(?:mahal sangat|terlalu mahal|jauh sangat|agak jauh)\b.{0,60}\b(?:fikir|pertimbang|banding|nanti|dulu)\b/,
  /\b(?:nak|mahu)\s+(?:tanya|check dengan)\s+(?:suami|isteri|partner|family|keluarga)\s+dulu\b/,
  /\b(?:kalau|jika)\b.{0,50}\b(?:discount|diskaun|murah|harga|promo|promosi)\b.{0,50}\b(?:saya|kami)\s+(?:akan|boleh|nak|mahu)\s+(?:ambil|beli|book|teruskan|proceed)\b/,
  /(?:还没决定|還沒決定|再考虑|再考慮|考虑一下|考慮一下|想一想|再想想|以后再说|以後再說|暂时不要|暫時不要|先比较|先比較|还在比较|還在比較|先问家人|先問家人)/,
  /(?:太贵|太貴|有点贵|有點貴|太远|太遠|有点远|有點遠).{0,30}(?:考虑|考慮|想想|比较|比較|以后|以後|迟点|遲點)/,
  /(?:如果|要是).{0,24}(?:折扣|优惠|優惠|便宜|价格|價格).{0,24}(?:我|我们|我們)(?:就|会|會|可以)?(?:要|买|買|拿|预约|預約|继续|繼續)/,
]);

const CLINIC_NEGATED_HOT_PATTERNS = frozenPatterns([
  /\b(?:don't|do not)\s+(?:(?:want|plan|intend)\s+to\s+)?(?:book|schedule|reserve|make an appointment|come|visit)\b/,
  /\b(?:won't|will not|am not going to|not going to)\s+(?:book|schedule|reserve|make an appointment|come|visit)\b/,
  /\b(?:tak nak|tidak mahu|tak mahu|tidak nak)\s+(?:book|booking|reserve|datang|visit|buat appointment|buat temujanji)\b/,
  /\b(?:tak|tidak)\s+akan\s+(?:datang|visit|book|booking|reserve)\b/,
  /(?:不想|不要|不打算)(?:预约|預約|预订|預訂|订位|訂位|去你们|去你們|过去|過去|到店|来|來)/,
]);

const CLINIC_HOT_INTENT_PATTERNS = frozenPatterns([
  /\b(?:i\s+)?(?:want|wanna|would like|i'd like|need|ready)\s+(?:to\s+)?(?:book|schedule|reserve|make\s+an?\s+appointment|come|visit)\b/,
  /\b(?:i(?:'ll| will)|we(?:'ll| will))\s+(?:come|visit)(?:\s+(?:today|tomorrow|later|tonight|this\s+weekend))?\b/,
  /\b(?:i(?:'m| am)|we(?:'re| are))\s+coming\s+(?:today|tomorrow|later|tonight|this\s+weekend|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|to\s+(?:the|your)\s+(?:clinic|centre|center|branch))\b/,
  /\b(?:i(?:'m| am)|we(?:'re| are))\s+(?:heading over|on (?:my|our) way)\b/,
  /\bsee you\b.{0,30}(?:today|tomorrow|tonight|later|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/,
  /\b(?:can|could|please)\s+(?:you\s+)?reserve(?:\s+(?:it|this|first|a\s+slot|the\s+slot))?\b/,
  /\b(?:have|ask|get)\s+(?:your\s+)?(?:staff|team|someone)\s+(?:to\s+)?(?:call|contact|whatsapp|message)\s+me\b/,
  /\b(?:i|we)\s+(?:want|would like|need)\s+to\s+(?:take|buy|get|purchase|proceed with|go ahead with)\s+(?:this|that|the)?\s*(?:package|promo(?:tion)?|offer|treatment|service)\b/,
  /\b(?:i'll|we'll|i will|we will)\s+(?:take|buy|get|purchase|go with|proceed with|go ahead with)\s+(?:this|that|the)?\s*(?:package|promo(?:tion)?|offer|treatment|service)\b/,
  /\b(?:i|we)\s+(?:want|would like)\s+(?:this|that|the)\s+(?:package|promo(?:tion)?|offer|treatment|service)\b/,
  /\b(?:i|we)\s+(?:want|would like|choose|pick)\s+(?:package|plan|option)\s*[a-z0-9-]+\b/,
  /\b(?:i|we)\s+(?:want|would like)\s+(?:the\s+)?rm\s*\d+(?:\.\d{1,2})?\s+(?:package|promo(?:tion)?|offer)\b/,
  /\b(?:how|where)\s+(?:do|can)\s+(?:i|we)\s+(?:pay|make\s+(?:the\s+)?payment|pay\s+(?:the\s+)?deposit)\b/,
  /\b(?:can|could|please)\s+(?:you\s+)?(?:send|give)\s+(?:me|us)\s+(?:the\s+)?(?:payment|deposit)\s+(?:link|details?|qr)\b/,
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
  /\b(?:saya|kami)\s+(?:akan\s+)?datang\s+(?:hari ini|esok|nanti|malam ini|sabtu|ahad|ke\s+(?:klinik|pusat|cawangan))\b/,
  /\b(?:saya|kami)\s+(?:dah|sudah)?\s*(?:on the way|otw)\b/,
  /\b(?:boleh|tolong)\s+reserve(?:\s+dulu)?\b/,
  /\b(?:boleh|tolong)\s+(?:suruh|minta)\s+(?:staff|team|orang)\s+(?:call|hubungi|whatsapp|mesej)\s+saya\b/,
  /\b(?:saya|kami)\s+(?:nak|mahu|hendak)\s+(?:ambil|beli|teruskan|proceed)\s+(?:package|pakej|promo|promosi|rawatan|treatment)\b/,
  /\b(?:saya|kami)\s+(?:nak|mahu|hendak)\s+(?:package|pakej|promo|promosi|rawatan|treatment)\s+(?:ini|tu|itu)\b/,
  /\b(?:saya|kami)\s+(?:nak|mahu|hendak|pilih)\s+(?:package|pakej|plan|option)\s*[a-z0-9-]+\b/,
  /\b(?:saya|kami)\s+(?:nak|mahu)\s+(?:promo|promosi|package|pakej)\s*rm\s*\d+(?:\.\d{1,2})?\b/,
  /\b(?:macam mana|bagaimana)\s+(?:nak|mahu)?\s*(?:bayar|buat\s+payment|bayar\s+deposit)\b/,
  /\b(?:boleh|tolong)\s+(?:hantar|bagi|beri)\s+(?:payment|bayaran|deposit)\s+(?:link|details?|qr)\b/,
  /\b(?:boleh|tolong)\s+(?:saya\s+)?(?:book|booking|buat\s+(?:appointment|temujanji|janji temu))\b/,
  /\b(?:boleh|dapatkah)\s+(?:saya|kami)\s+datang\b/,
  /\b(?:ada|masih ada)\s+(?:slot|appointment|temujanji|janji temu)\b/,
  /\b(?:macam mana|bagaimana)\s+(?:nak|mahu)?\s*(?:book|booking|buat\s+(?:appointment|temujanji|janji temu))\b/,
  /\b(?:bila|pukul berapa)\s+(?:ada\s+)?(?:slot|boleh datang|available)\b/,
  /(?:我)?(?:想|要|准备|準備)(?:预约|預約|预订|預訂|订位|訂位|去你们|去你們|过去|過去|到店)/,
  /(?:我|我们|我們)(?:今天|明天|等下|待会|待會|晚点|晚點)(?:会|會)?(?:过去|過去|来|來|到店)/,
  /(?:我|我们|我們)(?:会|會|准备|準備)(?:过去|過去|来|來|到店)/,
  /(?:我|我们|我們)(?:已经|已經)?(?:在路上|出发了|出發了)/,
  /(?:今天|明天|等下|待会|待會).{0,12}(?:见|見)/,
  /(?:可以|麻烦|麻煩|请|請)(?:先)?(?:帮我|幫我)?(?:留位|留个位置|留個位置|reserve)/,
  /(?:叫|请|請|让|讓).{0,8}(?:staff|客服|同事).{0,8}(?:联系我|聯繫我|打给我|打給我|call我)/,
  /(?:我|我们|我們)(?:要|想要|想拿|要拿|选|選|选择|選擇)(?:这个|這個|那个|那個)?(?:配套|套餐|package|优惠|優惠|promo|疗程|療程)/,
  /(?:我|我们|我們)(?:要|想要|选|選|选择|選擇)[a-z0-9]+(?:配套|套餐|package)/i,
  /(?:我|我们|我們)(?:想|要|可以)(?:继续|繼續|进行下一步|進行下一步|付款|付钱|付錢|付定金)/,
  /(?:怎么|怎麼|如何)(?:付款|付钱|付錢|付定金|交定金)/,
  /(?:发|發|给我|給我).{0,8}(?:付款|payment|定金).{0,8}(?:链接|連結|link|二维码|二維碼)/,
  /(?:可以|能不能|能|请|請|帮我|幫我)(?:帮我|幫我)?(?:预约|預約|预订|預訂|订位|訂位)/,
  /(?:有|还有|還有).{0,8}(?:空位|预约时间|預約時間|时间段|時間段|名额|名額)/,
  /(?:怎么|怎麼|如何|怎样|怎樣)(?:预约|預約|预订|預訂|付定金)/,
  /(?:哪天|几点|幾點|什么时间|什麼時間).{0,8}(?:有空|可以预约|可以預約|有位)/,
]);

const CLINIC_CONTEXT_PROMPT_PATTERNS = frozenPatterns([
  /\b(?:would|do)\s+you\s+like\s+(?:me\s+)?to\s+(?:book|schedule|reserve)/,
  /\b(?:would|do)\s+you\s+like\s+(?:to\s+)?(?:proceed|go ahead|continue)\b/,
  /\b(?:would|do)\s+you\s+like\s+to\s+(?:take|buy|choose|get)\s+(?:this|that|the)?\s*(?:package|promo(?:tion)?|offer|treatment|service)\b/,
  /\b(?:which|what)\s+(?:package|promo(?:tion)?|offer|option)\b.{0,50}\b(?:proceed|go with|take|buy|choose)\b/,
  /\b(?:nak|mahu)\s+(?:teruskan|proceed|ambil)\b/,
  /(?:要不要|想不想|需要我|可以帮你|可以幫你).{0,16}(?:继续|繼續|拿|付款)/,
  /\b(?:which|what)\s+(?:branch|day|date|time|slot)\b/,
  /\b(?:shall|can)\s+i\s+(?:book|schedule|confirm|reserve)/,
  /\b(?:appointment|booking|slot)\b.{0,60}\b(?:day|date|time|branch|confirm|available|work for you)\b/,
  /\b(?:cawangan|hari|tarikh|masa|pukul|slot|temujanji|janji temu)\b.{0,60}\b(?:mana|bila|sesuai|pilih|confirm|sahkan)\b/,
  /(?:要不要|需要我|可以帮你|可以幫你).{0,12}(?:预约|預約|订位|訂位)/,
  /(?:哪个|哪個|哪家|哪天|几号|幾號|几点|幾點|什么时间|什麼時間).{0,12}(?:分行|门店|門店|预约|預約|方便|合适|合適)/,
]);

const CLINIC_CONTEXT_CHOICE_PATTERNS = frozenPatterns([
  /^(?:package|plan|option|promo(?:tion)?)\s*[a-z0-9-]+[.! ]*$/,
  /^(?:pakej|package|promo|promosi)\s*[a-z0-9-]+[.! ]*$/,
  /^(?:配套|套餐|优惠|優惠)\s*[a-z0-9一二三四五六七八九十]+[。.!！ ]*$/i,
  /^[abc123][.! ]*$/i,
]);

const CLINIC_NON_CONFIRMING_CONTEXT_PATTERNS = frozenPatterns([
  /\b(?:can't|cannot|can not|unable|unavailable|not available|not free|doesn't work|does not work|won't work|will not work|need to reschedule|reschedule|cancel)\b/,
  /\b(?:tak boleh|tidak boleh|tak dapat|tidak dapat|tak free|tidak free|tak lapang|tidak lapang|tak sesuai|tidak sesuai|tukar|batal|cancel)\b/,
  /(?:不行|不可以|不能|没空|沒空|没有空|沒有空|不方便|改天|改期|取消)/,
]);

const TCM_HOT_INTENT_PATTERNS = frozenPatterns([
  ...CLINIC_HOT_INTENT_PATTERNS,
  /\b(?:i|we)\s+(?:want|would like|need)\s+(?:to\s+)?(?:book|schedule|arrange|have|get|do)?\s*(?:an?\s+)?assessment\b/,
  /\b(?:saya|kami)\s+(?:nak|mahu|hendak)\s+(?:buat|book|booking|arrange)?\s*(?:assessment|penilaian)\b/,
  /(?:我|我们|我們)(?:想|要)(?:预约|預約|安排|做)?(?:评估|評估|assessment)/,
]);

const TCM_UNCLEAR_HOT_PATTERNS = frozenPatterns([
  ...CLINIC_UNCLEAR_HOT_PATTERNS,
  /\b(?:do|would)\s+(?:i|we)\s+need\s+(?:an?\s+)?assessment\b/,
  /\b(?:i|we)\s+need\s+(?:an?\s+)?assessment\s*\?/,
  /\b(?:perlu|kena)\s+(?:saya|kami)\s+(?:buat\s+)?(?:assessment|penilaian)\s*(?:ke|kah)?\b/,
  /(?:我|我们|我們)?(?:需要|要)(?:做)?(?:评估|評估)吗/,
]);

const TCM_NEGATED_HOT_PATTERNS = frozenPatterns([
  ...CLINIC_NEGATED_HOT_PATTERNS,
  /\b(?:don't|do not|won't|will not|not ready to)\s+(?:book|schedule|arrange|have|get|do|want)?\s*(?:an?\s+)?assessment\b/,
  /\b(?:tak nak|tidak mahu|tak mahu|tidak nak)\s+(?:buat|book|booking|arrange)?\s*(?:assessment|penilaian)\b/,
  /(?:不想|不要|不打算)(?:预约|預約|安排|做)?(?:评估|評估|assessment)/,
]);

const TCM_CONTEXT_PROMPT_PATTERNS = frozenPatterns([
  ...CLINIC_CONTEXT_PROMPT_PATTERNS,
  /\b(?:would|do)\s+you\s+like\s+(?:me\s+)?to\s+(?:book|schedule|arrange)?\s*(?:an?\s+)?assessment\b/,
  /\b(?:shall|can)\s+i\s+(?:book|schedule|arrange)?\s*(?:an?\s+)?assessment\b/,
  /\b(?:nak|mahu)\s+(?:saya|kami)?\s*(?:buat|arrange|book)?\s*(?:assessment|penilaian)\b/,
  /(?:要不要|需要我|可以帮你|可以幫你).{0,12}(?:预约|預約|安排|做)?(?:评估|評估)/,
]);

const TCM_CONTEXT_CHOICE_PATTERNS = frozenPatterns([
  ...CLINIC_CONTEXT_CHOICE_PATTERNS,
  /^(?:an?\s+)?assessment(?:\s+(?:please|pls))?[.! ]*$/,
  /^(?:assessment|penilaian)(?:\s+(?:boleh|ya|please))?[.! ]*$/,
  /^(?:评估|評估)(?:可以|吧|就好)?[。.!！ ]*$/,
]);

const RENOVATION_ABSOLUTE_REJECTION_PATTERNS = frozenPatterns([
  ...UNIVERSAL_ABSOLUTE_REJECTION_PATTERNS,
  /\b(?:the\s+)?(?:renovation|project|renovation project)\s+(?:is\s+|was\s+)?(?:cancelled|canceled|called off)\b/,
  /\b(?:i|we)(?:'ve| have)?\s+(?:already\s+)?(?:hired|appointed|engaged|chosen)\s+(?:another|a different)\s+(?:contractor|renovator|interior designer|designer|carpenter)\b/,
  /\b(?:projek|project|renovation)\s+(?:dah|sudah)?\s*(?:batal|dibatalkan|tak jadi|tidak jadi)\b/,
  /\b(?:saya|kami)\s+(?:dah|sudah)\s+(?:pilih|upah|lantik)\s+(?:kontraktor|designer|pereka|tukang)\s+lain\b/,
  /(?:装修|裝修|工程|项目|項目)(?:已经|已經)?(?:取消了?|不做了|停了)/,
  /(?:已经|已經)(?:找了|请了|請了|选了|選了)(?:别的|別的|其他)(?:装修公司|裝修公司|承包商|设计师|設計師|木工)/,
]);

const RENOVATION_DECLINE_PATTERNS = frozenPatterns([
  /\b(?:i(?:'m| am)?\s+)?(?:not|no longer)\s+interested(?:\s+(?:anymore|in\s+(?:your\s+)?(?:service|services|renovation service|renovation services)))?(?:,?\s*(?:thanks?|thank you))?\s*[.!?]*$/,
  /\b(?:i|we)?\s*(?:don't|do not)\s+(?:want|need)\s+(?:this|it|that|the project|the renovation|your services?|to\s+(?:proceed|go ahead|continue|start))\b/,
  /\b(?:i|we)(?:'m| are| am)?\s+(?:not|no longer)\s+(?:proceeding|going ahead|moving forward)(?:\s+with\s+(?:this|the project|the renovation))?\b/,
  /\b(?:i|we)(?:\s+)?(?:won't|will not|am not going to|are not going to)\s+(?:proceed|go ahead|continue|start\s+(?:the\s+)?(?:project|renovation))\b/,
  /\b(?:not for me|i(?:'ll| will) pass)\b/,
  /\b(?:saya|kami)?\s*(?:tak|tidak)\s+berminat(?:\s+(?:lagi|dengan\s+(?:servis|renovation|ubah suai)))?(?:,?\s*(?:terima kasih|thanks?))?\s*[.!?]*$/,
  /\b(?:saya|kami)?\s*(?:tak|tidak)\s+(?:nak|mahu)\s+(?:ini|itu|servis\s+(?:ini|anda)|teruskan|proceed|buat\s+(?:renovation|ubah suai))\b/,
  /\b(?:saya|kami)?\s*(?:tak|tidak)\s+akan\s+(?:teruskan|proceed|buat\s+(?:renovation|ubah suai))\b/,
  /^(?:terima kasih,?\s*)?(?:saya|kami)?\s*(?:tak|tidak)\s+nak(?:,?\s*(?:terima kasih|thanks?))?\s*[.!?]*$/,
  /^(?:我|我们|我們)?(?:不感兴趣|沒興趣|没兴趣|不要了|不需要了|不用了|不做了|不继续了|不繼續了)(?:[,，]?(?:谢谢|謝謝))?[。.!！]*$/,
  /(?:我|我们|我們)?(?:不想|不要|不打算)(?:(?:继续|繼續|进行|進行)(?:这个|這個)?(?:装修|裝修|工程|项目|項目)?|装修|裝修|做这个项目|做這個項目|做这个工程|做這個工程)[。.!！]*$/,
]);

const RENOVATION_POSITIVE_CONTRAST_PATTERNS = frozenPatterns([
  /\b(?:but|however|instead|tapi|tetapi)\b.*\b(?:interested|want|need|quotation|quote|site visit|measurement|measure|proceed|go ahead|know more|how much|price|cost|nak|mahu|berminat|sebut harga|ukur|berapa|harga)\b/,
  /(?:但是|可是|不过|不過).*(?:想|要|有兴趣|有興趣|了解|报价|報價|上门|上門|量尺|测量|測量|继续|繼續|多少钱|多少錢|价格|價格|价钱|價錢)/,
]);

const RENOVATION_UNCLEAR_HOT_PATTERNS = frozenPatterns([
  /\b(?:maybe|perhaps|not ready|not yet|still thinking|need to think|just (?:asking|checking|comparing)|still comparing|compare (?:first|quotes?)|comparing quotes?|maybe later|later on|not now|too expensive|over budget|budget (?:is )?too high)\b/,
  /\b(?:don't|do not)\s+want\s+(?:a\s+)?(?:site visit|quotation|quote|measurement)\s+(?:yet|now)\b/,
  /\b(?:do|does|did)\s+(?:i|we)\s+need\s+(?:a\s+)?(?:site visit|site measurement|measurement|quotation|quote)\b/,
  /\b(?:perlu|kena)\s+(?:saya|kami)?\s*(?:buat|adakan|arrange)?\s*(?:site visit|lawatan tapak|ukur|ukuran|measurement|quotation|quote|sebut harga)\s*(?:ke|kah)\b/,
  /(?:需要|要)(?:上门|上門|现场|現場)?(?:测量|測量|量尺|site visit|报价|報價|quotation|quote)吗/,
  /\b(?:if|provided|assuming|as long as)\b.{0,80}\b(?:i|we)\s+(?:can|could|will|would|might)\s+(?:proceed|go ahead|move forward|start)\b/,
  /\b(?:i|we)\s+(?:can|could|will|would|might)\s+(?:proceed|go ahead|move forward|start)\b.{0,80}\b(?:if|provided|assuming|as long as)\b/,
  /\b(?:mungkin|belum (?:bersedia|nak|mahu)|masih fikir|nak fikir dulu|banding dulu|masih banding|compare dulu|nanti dulu|kemudian|mahal sangat|terlalu mahal|over budget|lebih bajet)\b/,
  /\b(?:tak|tidak)\s+nak\s+(?:site visit|quotation|sebut harga|ukur)\s+(?:dulu|lagi|sekarang)\b/,
  /\b(?:kalau|jika)\b.{0,80}\b(?:saya|kami)\s+(?:boleh|akan|mungkin)\s+(?:teruskan|proceed|mula)\b/,
  /\b(?:saya|kami)\s+(?:boleh|akan|mungkin)\s+(?:teruskan|proceed|mula)\b.{0,80}\b(?:kalau|jika)\b/,
  /(?:可能|也许|也許|还没决定|還沒決定|再考虑|再考慮|考虑一下|考慮一下|先比较|先比較|还在比较|還在比較|以后再说|以後再說|太贵|太貴|超预算|超預算|暂时不安排(?:上门|上門|量尺|测量|測量)|暫時不安排(?:上門|量尺|測量))/,
  /(?:如果|要是|只要).{0,30}(?:可以|能|会|會|就).{0,12}(?:继续|繼續|进行|進行|开始|開始)/,
  /(?:我|我们|我們)?(?:可以|能|会|會)(?:继续|繼續|进行|進行|开始|開始).{0,30}(?:如果|要是|只要)/,
]);

const RENOVATION_NEGATED_HOT_PATTERNS = frozenPatterns([
  /\b(?:don't|do not|won't|will not|not going to)\s+(?:want\s+to\s+)?(?:proceed|go ahead|move forward|continue|start|arrange\s+(?:a\s+)?site visit|request\s+(?:a\s+)?(?:quotation|quote))\b/,
  /\b(?:tak|tidak)\s+(?:nak|mahu|akan)\s+(?:teruskan|proceed|mula|buat\s+(?:renovation|ubah suai)|arrange\s+site visit|minta\s+(?:quotation|sebut harga))\b/,
  /\b(?:tak|tidak)\s+nak\s+(?:site visit|lawatan tapak|site measurement|measurement|ukur|ukuran|quotation|quote|sebut harga)\b/,
  /(?:不想|不要|不打算)(?:继续|繼續|进行|進行|开始|開始|安排上门|安排上門|要求报价|要求報價)/,
]);

const RENOVATION_HOT_INTENT_PATTERNS = frozenPatterns([
  /\b(?:i|we)?\s*(?:want|wanna|would like|i'd like|we'd like|ready)\s+(?:to\s+)?(?:proceed|go ahead|move forward|continue|start\s+(?:the\s+)?(?:project|renovation|work))\b/,
  /\b(?:let'?s|we can|i can)\s+(?:proceed|go ahead|move forward|start\s+(?:the\s+)?(?:project|renovation|work))\b/,
  /\b(?:can|could|would|please|kindly)\s+(?:you\s+)?(?:prepare|send|give|provide|issue|arrange)\s+(?:me\s+|us\s+)?(?:a\s+)?(?:quotation|quote|site visit|site measurement|measurement)\b/,
  /\b(?:i|we)?\s*(?:want|need|would like|i'd like|we'd like)\s+(?:a\s+)?(?:quotation|quote|site visit|site measurement|measurement)\b/,
  /\b(?:how|where)\s+(?:do|can)\s+(?:i|we)\s+(?:proceed|pay\s+(?:the\s+)?deposit|arrange\s+(?:a\s+)?site visit|get\s+(?:a\s+)?(?:quotation|quote))\b/,
  /\b(?:i|we)(?:'m| are| am)?\s+ready\s+to\s+pay\s+(?:the\s+)?deposit\b/,
  /\b(?:can|could|please)\s+(?:someone|your team|you)\s+(?:come|visit).{0,30}\b(?:measure|measurement|site)\b/,
  /\b(?:boleh|tolong)\s+(?:buat|sediakan|hantar|bagi|beri|arrange)\s+(?:saya|kami)?\s*(?:quotation|quote|sebut harga|site visit|lawatan tapak|site measurement|ukuran|ukur)\b/,
  /\b(?:saya|kami)?\s*(?:nak|mahu|hendak)\s+(?:teruskan|proceed|mula\s+(?:projek|renovation|ubah suai)|quotation|quote|sebut harga|site visit|lawatan tapak|ukur|ukuran)\b/,
  /\b(?:macam mana|bagaimana)\s+(?:nak|mahu)?\s*(?:teruskan|proceed|bayar\s+deposit|arrange\s+(?:site visit|lawatan tapak)|dapat\s+(?:quotation|sebut harga))\b/,
  /\b(?:boleh|dapatkah)\s+(?:datang|hantar orang).{0,30}\b(?:ukur|measurement|site)\b/,
  /(?:我|我们|我們)?(?:想|要|准备|準備)(?:继续|繼續|进行|進行|开始|開始)(?:装修|裝修|工程|项目|項目)?/,
  /(?:可以|能不能|请|請|麻烦|麻煩)(?:帮我|幫我)?(?:准备|準備|发|發|给|給|出|安排).{0,8}(?:报价|報價|上门|上門|量尺|测量|測量|site visit)/,
  /(?:我|我们|我們)?(?:想要|要|需要)(?:报价|報價|上门量尺|上門量尺|现场测量|現場測量|site visit)/,
  /(?:怎么|怎麼|如何)(?:付定金|交定金|继续|繼續|进行下一步|進行下一步|安排上门|安排上門|拿到报价|拿到報價)/,
]);

const RENOVATION_CONTEXT_PROMPT_PATTERNS = frozenPatterns([
  /\b(?:would|do)\s+you\s+like\s+(?:me|us|the team)?\s*(?:to\s+)?(?:arrange|prepare|continue with)?\s*(?:a\s+)?(?:site visit|quotation|quote|measurement)\b/,
  /\b(?:shall|can|could)\s+(?:i|we)\s+(?:arrange|prepare|send|ask\s+(?:the\s+)?team\s+to\s+arrange).{0,30}\b(?:site visit|quotation|quote|measurement)\b/,
  /\b(?:which|what)\s+(?:day|date|time)\b.{0,50}\b(?:site visit|measurement|visit)\b/,
  /\b(?:site visit|site measurement|measurement)\b.{0,60}\b(?:day|date|time|when|available|work for you|suitable|convenient)\b/,
  /\b(?:quotation|quote)\b.{0,60}\b(?:proceed|continue|prepare|send|team|next step)\b/,
  /\b(?:nak|mahu)\s+(?:kami|saya)?\s*(?:arrange|buat|sediakan|hantar)?\s*(?:site visit|lawatan tapak|quotation|sebut harga|ukur)\b/,
  /\b(?:hari|tarikh|masa|pukul)\b.{0,50}\b(?:site visit|lawatan tapak|ukur|measurement)\b/,
  /(?:要不要|需要我|需要我们|需要我們|可以帮你|可以幫你).{0,16}(?:安排上门|安排上門|上门量尺|上門量尺|报价|報價|site visit)/,
  /(?:哪天|几号|幾號|几点|幾點|什么时间|什麼時間).{0,16}(?:上门|上門|量尺|测量|測量|site visit|方便|合适|合適)/,
]);

const RENOVATION_CONTEXT_CHOICE_PATTERNS = frozenPatterns([
  /(?:^|[,.;]\s*)(?:quotation|quote|site visit|site measurement|measurement)(?:\s+(?:please|pls|instead|thanks?))?[.! ]*$/,
  /^(?:let'?s\s+(?:do|go with)|i(?:'d| would)?\s*(?:prefer|choose|want)|we(?:'d| would)?\s*(?:prefer|choose|want))\s+(?:the\s+)?(?:quotation|quote|site visit|site measurement|measurement)\b/,
  /(?:^|[,.;]\s*)(?:quotation|quote|sebut harga|site visit|lawatan tapak|ukur|ukuran|measurement)(?:\s+(?:boleh|ya|ok|okay|tolong|instead))?[.! ]*$/,
  /^(?:saya|kami)\s+(?:pilih|nak|mahu)\s+(?:quotation|quote|sebut harga|site visit|lawatan tapak|ukur|ukuran)\b/,
  /(?:^|[,，。]\s*)(?:先|就|要|选|選|选择|選擇)?(?:报价|報價|上门|上門|上门量尺|上門量尺|量尺|测量|測量)(?:吧|可以|就好|好了)?[。.!！ ]*$/,
]);

const RENOVATION_NON_CONFIRMING_CONTEXT_PATTERNS = frozenPatterns([
  /\b(?:can't|cannot|can not|unable|unavailable|not available|not free|doesn't work|does not work|won't work|will not work|need to reschedule|reschedule|cancel\s+(?:the\s+)?(?:visit|measurement))\b/,
  /\b(?:tak boleh|tidak boleh|tak dapat|tidak dapat|tak free|tidak free|tak lapang|tidak lapang|tak sesuai|tidak sesuai|tukar|batal\s+(?:site visit|lawatan|ukuran))\b/,
  /(?:不行|不可以|不能|没空|沒空|没有空|沒有空|不方便|改天|改期|取消(?:上门|上門|量尺|测量|測量))/,
]);

const LEAD_TEMPERATURE_RULE_PROFILES = Object.freeze({
  aesthetic_clinic: Object.freeze({
    id: "aesthetic_clinic",
    mode: "appointment",
    hotIntentPatterns: CLINIC_HOT_INTENT_PATTERNS,
    warmInterestPatterns: CLINIC_WARM_INTEREST_PATTERNS,
    warmCoolingPatterns: CLINIC_WARM_COOLING_PATTERNS,
    unclearHotPatterns: CLINIC_UNCLEAR_HOT_PATTERNS,
    negatedHotPatterns: CLINIC_NEGATED_HOT_PATTERNS,
    absoluteRejectionPatterns: CLINIC_ABSOLUTE_REJECTION_PATTERNS,
    declinePatterns: CLINIC_DECLINE_PATTERNS,
    positiveContrastPatterns: CLINIC_POSITIVE_CONTRAST_PATTERNS,
    alternativeContextPatterns: ALTERNATIVE_SCHEDULING_PATTERNS,
    contextPromptPatterns: CLINIC_CONTEXT_PROMPT_PATTERNS,
    contextConfirmPatterns: CONFIRMATION_PATTERNS,
    contextDetailPatterns: DATE_OR_TIME_PATTERNS,
    contextChoicePatterns: CLINIC_CONTEXT_CHOICE_PATTERNS,
    nonConfirmingContextPatterns: CLINIC_NON_CONFIRMING_CONTEXT_PATTERNS,
    allowConfiguredLocationAnswers: true,
    alternativeOverridesNonConfirming: false,
    hotMatchedRule: "booking_intent",
    hotReason: "The customer showed clear intent to proceed, purchase, pay, book, or arrange an appointment.",
    contextMatchedRule: "scheduling_confirmation",
    contextReason: "The customer confirmed a concrete booking, package, purchase, or other sales next step after the business prompted them.",
  }),
  tcm_clinic: Object.freeze({
    id: "tcm_clinic",
    mode: "appointment",
    hotIntentPatterns: TCM_HOT_INTENT_PATTERNS,
    warmInterestPatterns: CLINIC_WARM_INTEREST_PATTERNS,
    warmCoolingPatterns: CLINIC_WARM_COOLING_PATTERNS,
    unclearHotPatterns: TCM_UNCLEAR_HOT_PATTERNS,
    negatedHotPatterns: TCM_NEGATED_HOT_PATTERNS,
    absoluteRejectionPatterns: CLINIC_ABSOLUTE_REJECTION_PATTERNS,
    declinePatterns: CLINIC_DECLINE_PATTERNS,
    positiveContrastPatterns: CLINIC_POSITIVE_CONTRAST_PATTERNS,
    alternativeContextPatterns: ALTERNATIVE_SCHEDULING_PATTERNS,
    contextPromptPatterns: TCM_CONTEXT_PROMPT_PATTERNS,
    contextConfirmPatterns: CONFIRMATION_PATTERNS,
    contextDetailPatterns: DATE_OR_TIME_PATTERNS,
    contextChoicePatterns: TCM_CONTEXT_CHOICE_PATTERNS,
    nonConfirmingContextPatterns: CLINIC_NON_CONFIRMING_CONTEXT_PATTERNS,
    allowConfiguredLocationAnswers: true,
    alternativeOverridesNonConfirming: false,
    hotMatchedRule: "booking_intent",
    hotReason: "The patient showed clear intent to proceed, purchase, pay, arrange an assessment, or book an appointment.",
    contextMatchedRule: "scheduling_confirmation",
    contextReason: "The patient confirmed an assessment, appointment, package, purchase, or other concrete next step after the clinic prompted them.",
  }),
  home_renovation: Object.freeze({
    id: "home_renovation",
    mode: "project",
    hotIntentPatterns: RENOVATION_HOT_INTENT_PATTERNS,
    warmInterestPatterns: frozenPatterns([]),
    warmCoolingPatterns: frozenPatterns([]),
    unclearHotPatterns: RENOVATION_UNCLEAR_HOT_PATTERNS,
    negatedHotPatterns: RENOVATION_NEGATED_HOT_PATTERNS,
    absoluteRejectionPatterns: RENOVATION_ABSOLUTE_REJECTION_PATTERNS,
    declinePatterns: RENOVATION_DECLINE_PATTERNS,
    positiveContrastPatterns: RENOVATION_POSITIVE_CONTRAST_PATTERNS,
    alternativeContextPatterns: ALTERNATIVE_SCHEDULING_PATTERNS,
    contextPromptPatterns: RENOVATION_CONTEXT_PROMPT_PATTERNS,
    contextConfirmPatterns: CONFIRMATION_PATTERNS,
    contextDetailPatterns: DATE_OR_TIME_PATTERNS,
    contextChoicePatterns: RENOVATION_CONTEXT_CHOICE_PATTERNS,
    nonConfirmingContextPatterns: RENOVATION_NON_CONFIRMING_CONTEXT_PATTERNS,
    allowConfiguredLocationAnswers: false,
    alternativeOverridesNonConfirming: true,
    hotMatchedRule: "project_commitment",
    hotReason: "The customer showed clear intent to proceed with a renovation quotation, site visit, measurement, deposit, or project next step.",
    contextMatchedRule: "project_next_step_confirmation",
    contextReason: "The customer confirmed a renovation quotation or site-visit next step after the business asked how they wanted to proceed.",
  }),
  generic: Object.freeze({
    id: "generic",
    mode: "generic",
    hotIntentPatterns: frozenPatterns([]),
    warmInterestPatterns: frozenPatterns([]),
    warmCoolingPatterns: frozenPatterns([]),
    unclearHotPatterns: frozenPatterns([]),
    negatedHotPatterns: frozenPatterns([]),
    absoluteRejectionPatterns: UNIVERSAL_ABSOLUTE_REJECTION_PATTERNS,
    declinePatterns: GENERIC_DECLINE_PATTERNS,
    positiveContrastPatterns: GENERIC_POSITIVE_CONTRAST_PATTERNS,
    alternativeContextPatterns: frozenPatterns([]),
    contextPromptPatterns: frozenPatterns([]),
    contextConfirmPatterns: frozenPatterns([]),
    contextDetailPatterns: frozenPatterns([]),
    contextChoicePatterns: frozenPatterns([]),
    nonConfirmingContextPatterns: frozenPatterns([]),
    allowConfiguredLocationAnswers: false,
    alternativeOverridesNonConfirming: false,
    hotMatchedRule: null,
    hotReason: null,
    contextMatchedRule: null,
    contextReason: null,
  }),
});

function getLeadTemperatureRuleProfile(config = {}) {
  // A missing businessType means a pre-profile clinic runtime. Preserve the
  // historical classifier in that case rather than silently disabling rules.
  const rawType = config.businessType;
  if (!String(rawType || "").trim()) {
    return LEAD_TEMPERATURE_RULE_PROFILES.aesthetic_clinic;
  }
  const businessType = normalizeBusinessType(rawType);
  return LEAD_TEMPERATURE_RULE_PROFILES[businessType] || LEAD_TEMPERATURE_RULE_PROFILES.generic;
}

module.exports = {
  LEAD_TEMPERATURE_RULE_PROFILES,
  getLeadTemperatureRuleProfile,
};
