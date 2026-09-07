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
  /(?:但是|可是|不过|不過|，|。)(?:今天|明天|后天|後天|星期[一二三四五六日天]|周[一二三四五六日天]|週[一二三四五六日天]|这个周末|這個週末|下周|下週|\d{1,2}(?:点|點|时|時)).{0,20}(?:可以|没问题|沒問題|方便|有空|比较好|比較好)/,
]);

const GENERIC_DECLINE_PATTERNS = frozenPatterns([
  /\b(?:i(?:'m| am)?\s+)?(?:not|no longer)\s+interested(?:\s+anymore)?(?:,?\s*(?:thanks?|thank you))?\s*[.!?]*$/,
  /\b(?:i\s+)?(?:don't|do not)\s+(?:want|need)\s+(?:this|it|that|your services?)\b/,
  /\bno\s+thanks?(?:\s+you)?\b/,
  /\b(?:not for me|i(?:'ll| will) pass)\b/,
  /\b(?:saya\s+)?(?:tak|tidak)\s+berminat(?:\s+lagi)?(?:,?\s*(?:terima kasih|thanks?))?\s*[.!?]*$/,
  /^(?:terima kasih,?\s*)?(?:saya\s+)?(?:tak|tidak)\s+nak(?:,?\s*(?:terima kasih|thanks?))?\s*[.!?]*$/,
  /^(?:我)?(?:不感兴趣|没兴趣|沒有興趣|没有兴趣|不要了|不需要了|不用了|谢谢不用了?|謝謝不用了?)(?:，?(?:谢谢|謝謝))?[。.!！]*$/,
]);

const GENERIC_POSITIVE_CONTRAST_PATTERNS = frozenPatterns([
  /(?:\b(?:but|however|instead|tapi|tetapi)\b.*\b(?:interested|want|need|know more|how much|price|cost|nak|mahu|berminat|berapa|harga)\b|(?:但是|可是|不过|不過).*(?:想|要|有兴趣|有興趣|了解|多少钱|多少錢|价格|價格|价钱|價錢))/,
]);

const CLINIC_DECLINE_PATTERNS = frozenPatterns([
  /\b(?:i(?:'m| am)?\s+)?(?:not|no longer)\s+interested(?:\s+(?:anymore|in\s+(?:your\s+)?(?:service|services|treatment|treatments|clinic)))?(?:,?\s*(?:thanks?|thank you))?\s*[.!?]*$/,
  /\b(?:i\s+)?(?:don't|do not)\s+(?:want|need)\s+(?:this|it|that|the treatment|your services?|an?\s+appointment|to\s+(?:book|schedule|make an appointment))\b/,
  /\b(?:i\s+)?(?:don't|do not)\s+(?:want|plan|intend)\s+to\s+(?:come|visit|reserve)\b/,
  /\b(?:i(?:'m| am)?\s+)?(?:won't|will not|am not going to|not going to)\s+(?:book|schedule|make an appointment)\b/,
  /\b(?:i(?:'m| am)?\s+)?(?:won't|will not|am not going to|not going to)\s+(?:come|visit|reserve)\b/,
  /\bno\s+thanks?(?:\s+you)?\b/,
  /\b(?:not for me|i(?:'ll| will) pass)\b/,
  /\b(?:saya\s+)?(?:tak|tidak)\s+berminat(?:\s+(?:lagi|dengan\s+(?:servis|rawatan)(?:\s+(?:ini|anda|awak))?))?(?:,?\s*(?:terima kasih|thanks?))?\s*[.!?]*$/,
  /\b(?:saya\s+)?(?:tak|tidak)\s+(?:nak|mahu)\s+(?:ini|itu|rawatan\s+ini|servis\s+(?:ini|anda)|book|booking|reserve|datang|visit|buat\s+(?:appointment|temujanji|janji temu))\b/,
  /\b(?:saya\s+)?(?:tak|tidak)\s+akan\s+(?:datang|visit|book|booking|reserve)\b/,
  /\b(?:saya\s+)?(?:tak|tidak)\s+(?:perlu|payah)(?:\s+(?:ini|itu|servis|rawatan))?(?:,?\s*(?:terima kasih|thanks?))?\s*[.!?]*$/,
  /^(?:terima kasih,?\s*)?(?:saya\s+)?(?:tak|tidak)\s+nak(?:,?\s*(?:terima kasih|thanks?))?\s*[.!?]*$/,
  /^(?:我)?(?:不感兴趣|没兴趣|沒有興趣|没有兴趣|不要了|不需要了|不用了|谢谢不用了?|謝謝不用了?)(?:，?(?:谢谢|謝謝))?[。.!！]*$/,
  /^(?:我)?(?:对|對)(?:你们|你們|这项|這項)?(?:服务|服務|疗程|療程)(?:不感兴趣|没兴趣|沒有興趣|没有兴趣)[。.!！]*$/,
  /^(?:我)?(?:不想|不要|不打算)(?:预约|預約|预订|預訂|订位|訂位|去你们|去你們|过去|過去|到店|来|來)(?:诊所|診所|门店|門店)?[。.!！]*$/,
]);

const CLINIC_POSITIVE_CONTRAST_PATTERNS = frozenPatterns([
  /(?:\b(?:but|however|instead|tapi|tetapi)\b.*\b(?:interested|want|need|book|appointment|know more|how much|price|cost|nak|mahu|berminat|berapa|harga)\b|(?:但是|可是|不过|不過).*(?:想|要|有兴趣|有興趣|了解|预约|預約|多少钱|多少錢|价格|價格|价钱|價錢))/,
]);

const CLINIC_UNCLEAR_HOT_PATTERNS = frozenPatterns([
  /\b(?:maybe|perhaps|not ready|not yet|still thinking|just (?:asking|checking|browsing)|(?:don't|do not) want to book (?:yet|now)|not booking (?:yet|now))\b/,
  /\bi\s+(?:may|might)\s+(?:want\s+to\s+)?(?:book|schedule|come|visit)\b/,
  /\b(?:belum (?:bersedia|nak|mahu)|mungkin|masih fikir|tanya sahaja|tanya saja|survey dulu|(?:tak nak|tidak mahu) book (?:dulu|lagi|sekarang))\b/,
  /(?:可能|也许|也許|还不想预约|還不想預約|暂时不预约|暫時不預約|还没决定|還沒決定|先看看|只是问问|只是問問|以后再说|以後再說)/,
  /\b(?:visit|check|open)\s+(?:your\s+)?(?:website|site|page|instagram|facebook)\b/,
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
]);

const CLINIC_CONTEXT_PROMPT_PATTERNS = frozenPatterns([
  /\b(?:would|do)\s+you\s+like\s+(?:me\s+)?to\s+(?:book|schedule|reserve)/,
  /\b(?:which|what)\s+(?:branch|day|date|time|slot)\b/,
  /\b(?:shall|can)\s+i\s+(?:book|schedule|confirm|reserve)/,
  /\b(?:appointment|booking|slot)\b.{0,60}\b(?:day|date|time|branch|confirm|available|work for you)\b/,
  /\b(?:cawangan|hari|tarikh|masa|pukul|slot|temujanji|janji temu)\b.{0,60}\b(?:mana|bila|sesuai|pilih|confirm|sahkan)\b/,
  /(?:要不要|需要我|可以帮你|可以幫你).{0,12}(?:预约|預約|订位|訂位)/,
  /(?:哪个|哪個|哪家|哪天|几号|幾號|几点|幾點|什么时间|什麼時間).{0,12}(?:分行|门店|門店|预约|預約|方便|合适|合適)/,
]);

const CLINIC_NON_CONFIRMING_CONTEXT_PATTERNS = frozenPatterns([
  /\b(?:can't|cannot|can not|unable|unavailable|not available|not free|doesn't work|does not work|won't work|will not work|need to reschedule|reschedule|cancel)\b/,
  /\b(?:tak boleh|tidak boleh|tak dapat|tidak dapat|tak free|tidak free|tak lapang|tidak lapang|tak sesuai|tidak sesuai|tukar|batal|cancel)\b/,
  /(?:不行|不可以|不能|没空|沒空|没有空|沒有空|不方便|改天|改期|取消)/,
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
  /\bno\s+thanks?(?:\s+you)?\b/,
  /\b(?:not for me|i(?:'ll| will) pass)\b/,
  /\b(?:saya|kami)?\s*(?:tak|tidak)\s+berminat(?:\s+(?:lagi|dengan\s+(?:servis|renovation|ubah suai)))?(?:,?\s*(?:terima kasih|thanks?))?\s*[.!?]*$/,
  /\b(?:saya|kami)?\s*(?:tak|tidak)\s+(?:nak|mahu)\s+(?:ini|itu|servis\s+(?:ini|anda)|teruskan|proceed|buat\s+(?:renovation|ubah suai))\b/,
  /\b(?:saya|kami)?\s*(?:tak|tidak)\s+akan\s+(?:teruskan|proceed|buat\s+(?:renovation|ubah suai))\b/,
  /^(?:terima kasih,?\s*)?(?:saya|kami)?\s*(?:tak|tidak)\s+nak(?:,?\s*(?:terima kasih|thanks?))?\s*[.!?]*$/,
  /^(?:我|我们|我們)?(?:不感兴趣|沒興趣|没兴趣|不要了|不需要了|不用了|不做了|不继续了|不繼續了)(?:，?(?:谢谢|謝謝))?[。.!！]*$/,
  /(?:我|我们|我們)?(?:不想|不要|不打算)(?:继续|繼續|进行|進行|装修|裝修|做这个项目|做這個項目|做这个工程|做這個工程)[。.!！]*$/,
]);

const RENOVATION_POSITIVE_CONTRAST_PATTERNS = frozenPatterns([
  /\b(?:but|however|instead|tapi|tetapi)\b.*\b(?:interested|want|need|quotation|quote|site visit|measurement|measure|proceed|go ahead|know more|how much|price|cost|nak|mahu|berminat|sebut harga|ukur|berapa|harga)\b/,
  /(?:但是|可是|不过|不過).*(?:想|要|有兴趣|有興趣|了解|报价|報價|上门|上門|量尺|测量|測量|继续|繼續|多少钱|多少錢|价格|價格|价钱|價錢)/,
]);

const RENOVATION_UNCLEAR_HOT_PATTERNS = frozenPatterns([
  /\b(?:maybe|perhaps|not ready|not yet|still thinking|need to think|just (?:asking|checking|comparing)|still comparing|compare (?:first|quotes?)|comparing quotes?|maybe later|later on|not now|too expensive|over budget|budget (?:is )?too high)\b/,
  /\b(?:don't|do not)\s+want\s+(?:a\s+)?(?:site visit|quotation|quote|measurement)\s+(?:yet|now)\b/,
  /\b(?:mungkin|belum (?:bersedia|nak|mahu)|masih fikir|nak fikir dulu|banding dulu|masih banding|compare dulu|nanti dulu|kemudian|mahal sangat|terlalu mahal|over budget|lebih bajet)\b/,
  /\b(?:tak|tidak)\s+nak\s+(?:site visit|quotation|sebut harga|ukur)\s+(?:dulu|lagi|sekarang)\b/,
  /(?:可能|也许|也許|还没决定|還沒決定|再考虑|再考慮|考虑一下|考慮一下|先比较|先比較|还在比较|還在比較|以后再说|以後再說|太贵|太貴|超预算|超預算|暂时不安排(?:上门|上門|量尺|测量|測量)|暫時不安排(?:上門|量尺|測量))/,
]);

const RENOVATION_NEGATED_HOT_PATTERNS = frozenPatterns([
  /\b(?:don't|do not|won't|will not|not going to)\s+(?:want\s+to\s+)?(?:proceed|go ahead|move forward|continue|start|arrange\s+(?:a\s+)?site visit|request\s+(?:a\s+)?(?:quotation|quote))\b/,
  /\b(?:tak|tidak)\s+(?:nak|mahu|akan)\s+(?:teruskan|proceed|mula|buat\s+(?:renovation|ubah suai)|arrange\s+site visit|minta\s+(?:quotation|sebut harga))\b/,
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
  /\b(?:site visit|site measurement|measurement|quotation|quote)\b/,
  /\b(?:lawatan tapak|site visit|ukur|ukuran|measurement|quotation|sebut harga)\b/,
  /(?:上门|上門|量尺|测量|測量|报价|報價|site visit)/,
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
    unclearHotPatterns: CLINIC_UNCLEAR_HOT_PATTERNS,
    negatedHotPatterns: CLINIC_NEGATED_HOT_PATTERNS,
    absoluteRejectionPatterns: UNIVERSAL_ABSOLUTE_REJECTION_PATTERNS,
    declinePatterns: CLINIC_DECLINE_PATTERNS,
    positiveContrastPatterns: CLINIC_POSITIVE_CONTRAST_PATTERNS,
    alternativeContextPatterns: ALTERNATIVE_SCHEDULING_PATTERNS,
    contextPromptPatterns: CLINIC_CONTEXT_PROMPT_PATTERNS,
    contextConfirmPatterns: CONFIRMATION_PATTERNS,
    contextDetailPatterns: DATE_OR_TIME_PATTERNS,
    contextChoicePatterns: frozenPatterns([]),
    nonConfirmingContextPatterns: CLINIC_NON_CONFIRMING_CONTEXT_PATTERNS,
    allowConfiguredLocationAnswers: true,
    alternativeOverridesNonConfirming: false,
    hotMatchedRule: "booking_intent",
    hotReason: "The customer showed clear booking or appointment intent.",
    contextMatchedRule: "scheduling_confirmation",
    contextReason: "The customer confirmed scheduling details after a booking question.",
  }),
  home_renovation: Object.freeze({
    id: "home_renovation",
    mode: "project",
    hotIntentPatterns: RENOVATION_HOT_INTENT_PATTERNS,
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

const BUSINESS_TYPE_ALIASES = Object.freeze({
  aesthetic_clinic: "aesthetic_clinic",
  aesthetic: "aesthetic_clinic",
  clinic: "aesthetic_clinic",
  medical_aesthetic: "aesthetic_clinic",
  home_renovation: "home_renovation",
  renovation: "home_renovation",
  carpentry: "home_renovation",
  cabinetry: "home_renovation",
  generic: "generic",
  business: "generic",
});

function normalizeBusinessType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return BUSINESS_TYPE_ALIASES[normalized] || null;
}

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
