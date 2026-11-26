"use strict";

const { detectExplicitLanguagePreference, detectMessageLanguage } = require("./chatLanguage");

// Append *configured* business facts only when the current customer message
// asks a second administrative question alongside verified treatment pricing.
// Never derive an address from Gemini, an ad, CRM labels or older chat history.
// Only an actual request for the BUSINESS location may append a branch
// address. "位置" (body position), English "located" (symptom location)
// and generic Malay "kat mana" are NOT sufficient by themselves.
const BUSINESS_LOCATION_ZH =
  /(?:地址|(?<!痛)(?<!疼)地[点點](?:\s*[?？]|.{0,8}(?:在哪(?:里|裡|儿|兒)?|哪[里裡]|位置))|(?:诊所|診所|门店|門店|中心|分行|店面|店址|店铺|店舖|贵店|貴店|你们|你們|你家|你那边|你那邊|你们那边|你們那邊).{0,16}(?:在哪(?:里|裡|儿|兒)?|哪[里裡]|位置|怎么去|怎麼去)|(?:在哪(?:里|裡|儿|兒)?|哪[里裡]).{0,16}(?:诊所|診所|门店|門店|中心|分行|店面|店址|店铺|店舖))/iu;
const BUSINESS_LOCATION_EN =
  /\b(?:address|directions|(?:your|our|clinic|centre|center|branch|outlet|shop|store|business)\s+location|where\s+(?:are\s+you(?:\s+located)?|is\s+(?:(?:your|the|this)\s+)?(?:clinic|centre|center|branch|outlet|shop|store|business)(?:\s+located)?)|where\s+can\s+i\s+find\s+you|(?:your|the)\s+(?:clinic|centre|center|branch|outlet)\s+(?:address|location)|(?:clinic|centre|center|branch|outlet)\s+near\s+me)\b/iu;
const BUSINESS_LOCATION_MS =
  /\b(?:alamat|lokasi\s+(?:klinik|pusat|cawangan|kedai|anda|awak|kamu)|(?:klinik|pusat|cawangan|kedai)\s+(?:di\s+mana|dimana|kat\s+mana)|(?:di\s+mana|dimana|kat\s+mana)\s+(?:klinik|pusat|cawangan|kedai))\b/iu;

const HOURS_QUESTION =
  /(?:营业时间|營業時間|营业到几点|營業到幾點|几点开|幾點開|几点关|幾點關|几时开|幾時開|几时关|幾時關|开门时间|開門時間|\b(?:opening hours|business hours|operating hours|what time (?:do you )?(?:open|close)|when (?:do you )?(?:open|close)|waktu operasi|waktu buka|jam buka|masa operasi|pukul berapa (?:buka|tutup))\b)/iu;

function isBusinessLocationQuestion(customerText) {
  const value = String(customerText || "");
  return BUSINESS_LOCATION_ZH.test(value) || BUSINESS_LOCATION_EN.test(value) ||
    BUSINESS_LOCATION_MS.test(value);
}

// Full-question evidence for replacing a reply, separate from the broad
// location mention detector used by append-only mixed-question handling.
// No city list. Unknown phrasing remains with the AI rather than guessing.
function standaloneLocationQuestion(customerText, modelLocationOnly = false) {
  const input=String(customerText || "").trim();
  if (!input || input.length>130) return false;
  let q=input;
  // Remove only an independently recognized leading language instruction.
  const first=q.match(/^([^.!?。！？,，:：]+)[.!?。！？,，:：]\s*(.+)$/su);
  if(first && detectExplicitLanguagePreference(first[1])) q=first[2].trim();
  q=q.replace(/[?？。.!！\s]+$/gu,"").trim();
  const zh=/^(?:请问|請問|想问|想問|你好|您好)?[\s，,]*(?:(?:你们|你們|你家|贵店|貴店|(?:你们|你們)?(?:的)?(?:诊所|診所|门店|門店|中心|分行|店面|店铺|店舖|店))?(?:的)?(?:地址|地点|地點)(?:是(?:什么|甚麼)|在哪(?:里|裡|儿|兒)?|在哪里|在哪裡|呢|在哪里呢)?|(?:你们|你們|你家|贵店|貴店|(?:你们|你們)?(?:的)?(?:诊所|診所|门店|門店|中心|分行|店面|店铺|店舖|店))(?:是)?(?:在哪(?:里|裡|儿|兒)?|哪里|哪裡|怎么去|怎麼去)(?:呢|呀|啊)?|(?:可以|能)(?:给|給|发|發)(?:我)?(?:你们的|你們的)?地址(?:吗|嗎)?)$/u;
  const en=/^(?:hi[, ]+|hello[, ]+)?(?:(?:please |can you |could you )?(?:share|send|give)(?: me)? (?:your |the |clinic )?address(?: please)?|(?:your |the |clinic |our )?(?:address|location)(?: please)?|where (?:are you(?: located)?|is (?:your |the |this )?(?:clinic|centre|center|branch|outlet|shop|store|business)(?: located)?|can i find you)(?: please)?)$/iu;
  const ms=/^(?:(?:boleh (?:tahu|share|bagi|beri|hantar) )?(?:alamat|lokasi)(?: (?:klinik|clinic|pusat|cawangan|kedai|anda|awak|kamu))?|(?:klinik|clinic|pusat|cawangan|kedai) (?:di mana|dimana|kat mana)|(?:di mana|dimana|kat mana) (?:klinik|clinic|pusat|cawangan|kedai))$/iu;
  if(zh.test(q)||en.test(q)||ms.test(q)) return true;
  // Contextual correction requires BOTH the model decision and a complete
  // business-location question. No action for a bare model flag.
  if(!modelLocationOnly) return false;
  return /^(?:你们|你們|你家|贵店|貴店|(?:你们|你們)?(?:的)?(?:店|门店|門店|诊所|診所|中心|分行))\s*(?:不是|不|是)?在\s*[\p{L}][\p{L}\p{M} .'-]{0,48}\s*(?:吗|嗎|呢)$/u.test(q)
    || /^(?:aren't|are|isn't|is)\s+(?:you|your (?:clinic|centre|center|branch|shop)|the (?:clinic|centre|center|branch|shop))\s+(?:located |based )?(?:in|at)\s+[\p{L}][\p{L}\p{M} .'-]{0,48}$/iu.test(q);
}

// Configured facts are independent of customer intent. The offline/live
// benchmark can verify a raw address claim without authorizing a reply rewrite.
function singleBranchLocationFacts(branches, language = "zh") {
  if (!Array.isArray(branches) || branches.length !== 1) return null;
  const branch = branches[0];
  if (typeof branch?.address !== "string" || !branch.address.trim()) return null;
  const locale = String(language || "zh").toLowerCase();
  return {
    verifiedAddress: branch.address.trim(),
    verifiedName: String(branch.name || "").trim(),
    language: locale.startsWith("ms") ? "ms" : locale.startsWith("en") ? "en" : "zh",
  };
}

// Safe, standalone business-address response from Settings. Do not use a
// treatment location ("my pain is located here") to authorize this response.
// When a question also asks for a package price, leave the combined answer to
// the normal verified pricing path.
function confirmedSingleBranchLocationAnswer({
  customerText = "", branches = [], language = "zh", modelLocationOnly = false, resolvedLanguage = null, omitInvitation = false,
} = {}) {
  const question = String(customerText || "").trim();
  if (!question || question.length > 130 || !standaloneLocationQuestion(question, modelLocationOnly) ||
      /(?:疼|痛|不舒服|症状|症狀|部位|身体|身體|[价價][钱錢格]|多少钱|多少錢|收费|收費|费用|費用|优惠|優惠|配套|套餐|活动|活動|[预預]约|[病癌]|(?:\b(?:price|cost|fee|promo|package|treatment|pain|symptom|booking|appointment|rawatan|harga)\b))/iu.test(question)) return null;
  // Production has already resolved the language for this turn; direct
  // legacy callers can still infer it from the current message.
  const facts = singleBranchLocationFacts(branches, resolvedLanguage ||
    detectExplicitLanguagePreference(question) || detectMessageLanguage(question) || language);
  if (!facts) return null;
  const {verifiedName: name, verifiedAddress: address} = facts;
  const ms = facts.language === "ms";
  const en = facts.language === "en";
  return {
    kind: "verified_location",
    ...facts,
    reply: ms
      ? "Kami berada di " + (name || "klinik kami") + " 😊\n📍 " + address
        + (modelLocationOnly || omitInvitation ? "" : "\nBila masa yang sesuai untuk datang? Kami boleh bantu semak temujanji.")
      : en
        ? "We're located in " + (name || "our clinic") + " 😊\n📍 " + address
          + (modelLocationOnly || omitInvitation ? "" : "\nWhich day would be convenient for you? We can help check appointment arrangements.")
        : "我们位于 " + (name || "门店") + " 😊\n📍 " + address
          + (modelLocationOnly || omitInvitation ? "" : "\n请问你哪一天比较方便过来呢？我可以帮你了解预约安排 ☺️"),
  };
}

// Only authorize an unchanged, self-contained address answer. This is a
// bounded factual-output contract, not a customer-intent or city-name parser.
// Any unrecognized extra prose stays on the established safe fallback path.
// The full configured address must occur exactly once; contradictory claims,
// unsupported directions/landmarks, pricing and scheduling claims cannot pass.
function verifyLocationDraft(reply, facts) {
  if (typeof reply !== "string" || !reply.trim()) return "no_draft";
  if (!facts?.verifiedAddress) return "unconfigured";
  const norm = value => String(value || "").normalize("NFKC")
    .replace(/\s+/gu," ").trim().toLowerCase();
  const original = norm(reply), address = norm(facts.verifiedAddress);
  const index = original.indexOf(address);
  if (index < 0) return "address_missing";
  if (original.indexOf(address,index+address.length) >= 0) return "extra_or_unverified_text";
  const clean = value => value.replace(/[\p{P}\p{S}\p{Extended_Pictographic}\uFE0F\u200D]+/gu," ").replace(/\s+/gu," ").trim();
  let prefix=clean(original.slice(0,index)), suffix=clean(original.slice(index+address.length));
  // Optional branch name must be the exact configured name, in a location
  // statement. Do not globally erase it from arbitrary prose.
  const name=clean(norm(facts.verifiedName));
  const endings={zh:["哦","呀","呢","啦"],en:[""],ms:["ya"]};
  if (suffix && !(endings[facts.language]||[]).includes(suffix)) return "extra_or_unverified_text";
  const wrappers={
    zh:["","地址","我们的地址","门店地址","我们在","我们位于","我们只有一间店在","我们目前在","我们坐落在","我们的门店在","门店位于","亲爱的 我们在","您好 我们在","你好 我们在"],
    en:["","address","our address","clinic address","we re located at","we are located at","we re located in","we are located in","our clinic is located in","our clinic is located at","we re based in","we are based in","we re at","we are at","our clinic is at","you can find us at","here is our address","hi here is our address"],
    ms:["","alamat","alamat kami","alamat klinik","kami berada di","kami terletak di","klinik kami terletak di","lokasi kami di","klinik kami di","ini alamat kami"],
  };
  const allowed=wrappers[facts.language]||[];
  if (allowed.includes(prefix)) return "verified_address_only";
  if (name) {
    const labels=facts.language==="zh"?["","地址","哦 地址","哦"]:facts.language==="ms"?["","alamat","ya alamat"]:["","address"];
    for (const start of allowed) for (const label of labels) {
      const joined=[start,name,label].filter(Boolean).join(" ");
      if (prefix===joined || (facts.language==="zh" && prefix.replace(/ /gu,"")===joined.replace(/ /gu,"")))
        return "verified_address_only";
    }
  }
  return "extra_or_unverified_text";
}

function appendRequestedBusinessFacts({
  customerText = "", reply = "", branches = [], hours = null, language = "zh",
} = {}) {
  const current = String(customerText || "");
  const source = String(reply || "");
  if (!current.trim() || !source.trim()) return source;

  const wantsLocation = isBusinessLocationQuestion(current);
  const wantsHours = HOURS_QUESTION.test(current);
  if (!wantsLocation && !wantsHours) return source;

  const validBranches = (Array.isArray(branches) ? branches : []).filter(b =>
    b && typeof b.address === "string" && b.address.trim()
  );
  const lang = String(language || "").toLowerCase();
  const ms = lang.startsWith("ms");
  const en = lang.startsWith("en");
  let branch = validBranches.length === 1 ? validBranches[0] : null;

  // Never choose an arbitrary branch if a business has several locations.
  // A user may explicitly name the relevant configured branch.
  if (!branch && validBranches.length > 1) {
    const matching = validBranches.filter(b =>
      typeof b.name === "string" && b.name.trim().length >= 3 &&
      current.toLocaleLowerCase().includes(b.name.trim().toLocaleLowerCase())
    );
    if (matching.length === 1) branch = matching[0];
  }

  const additional = [];
  if (wantsLocation) {
    if (branch) {
      const address = branch.address.trim();
      if (!source.toLocaleLowerCase().includes(address.toLocaleLowerCase())) {
        const name = typeof branch.name === "string" ? branch.name.trim() : "";
        additional.push(
          ms ? (name ? "Kami berada di " + name + ".\n" : "") + "Alamat: " + address
            : en ? (name ? "We're located in " + name + ".\n" : "") + "Address: " + address
              : (name ? "我们在 " + name + " 哦～\n" : "") + "地址：" + address + " 😊"
        );
      }
    } else if (validBranches.length > 1) {
      additional.push(ms
        ? "Kami mempunyai beberapa cawangan. Cawangan yang mana anda ingin tahu alamatnya?"
        : en ? "We have multiple branches. Which branch's address would you like?"
          : "我们有多个分行，请问你想了解哪一家分行的地址呢？");
    }
    // Missing/invalid configuration: never invent an address.
  }

  // Shared opening hours are only safe when the branch is unambiguous.
  if (wantsHours && branch && hours && typeof hours === "object") {
    const general = typeof hours.general === "string" ? hours.general.trim() : "";
    const closed = typeof hours.closed === "string" ? hours.closed.trim() : "";
    const confirmed = [general, closed].filter(Boolean).join("；");
    if (confirmed && (!general || !source.includes(general))) {
      additional.push(ms ? "Waktu operasi: " + confirmed :
        en ? "Opening hours: " + confirmed : "营业时间：" + confirmed);
    }
  }

  return additional.length ? [source, ...additional].join("\n\n") : source;
}


// Do not tell a customer that this clinic has multiple branches when the
// configured, verified location list contains only one. This correction
// never chooses an address from an ad, AI guess or CRM text.
const FALSE_BRANCHES=/(?:多个|多間|多家|几家|幾家|好几|幾間|different|several|multiple|many|various|a\s+few|beberapa|banyak).{0,20}(?:分行|分店|门店|門店|branch|branches|outlets?|cawangan)|(?:分行|分店|门店|門店|branches|outlets?|cawangan).{0,16}(?:很多|多个|多間|多家|好几|several|multiple|many|beberapa)/iu;
// Require a complete Chinese branch-choice noun. `哪一` alone is only
// a prefix and also appears in `哪一种套餐`, which is NOT about branches.
// Keep actual `哪一家分行` / `哪个门店` correction intact.
const FALSE_BRANCH_CHOICE=/(?:最方便|最近|附近|哪(?:一家|一间|一間|一个|一個|家|间|間|个|個)|nearest|closest|which|most\s+convenient).{0,18}(?:分行|分店|门店|門店|branch|branches|outlets?|cawangan)|(?:分行|分店|门店|門店|branches|outlets?|cawangan).{0,12}(?:最方便|最近|哪(?:一家|一间|一間|一个|一個|家|间|間|个|個)|nearest|closest|which)/iu;
const UNNECESSARY_AREA=/(?:靠近哪一区|靠近哪一區|靠近哪个区|靠近哪個區|在哪一区|在哪一區|which\s+area\s+(?:are\s+you|do\s+you)|what\s+area\s+(?:are\s+you|do\s+you)|kawasan\s+mana)/iu;
function correctUnsupportedBranchReply({customerText="",reply="",branches=[],language="zh"}={}){
 const items=(Array.isArray(branches)?branches:[]).filter(b=>
   b&&typeof b.name==="string"&&b.name.trim()&&typeof b.address==="string"&&b.address.trim());
 const original=String(reply||"").trim();
 const choice=FALSE_BRANCH_CHOICE.test(original);
 const multiple=FALSE_BRANCHES.test(original);
 if(items.length!==1||!original||(!choice&&!multiple))
   return {reply:original,changed:false};
 const b=items[0],lang=String(language||"").toLowerCase();
 const fact=lang.startsWith("en")
  ?"Our currently confirmed location is "+b.name.trim()+". Address: "+b.address.trim()+". 😊"
  :lang.startsWith("ms")
   ?"Lokasi yang disahkan ialah "+b.name.trim()+". Alamat: "+b.address.trim()+". 😊"
   :"我们目前确认的门店在"+b.name.trim()+"哦 😊\n地址："+b.address.trim()+"。";
 // Work at clause boundaries, not the first false claim in a full sentence:
 // "我们有多个分行，3D First Trial RM488，你方便什么时候来？"
 // must retain the price and appointment question.
 const clauses=original.match(/[^，,；;。.!！?？\n]+[，,；;。.!！?？\n]*/gu)||[original];
 const misleadingArea=/(?:你|您).{0,12}(?:靠近哪里|靠近哪裡|想去哪家|想去哪一家|想去哪間|想去哪间|选哪家|選哪家|which branch|which outlet)|(?:which|what).{0,12}(?:branch|outlet|cawangan)/iu;
 const emptyPreamble=/^(?:我们有|我們有|我们|我們|我帮你看看|我幫你看看|帮你看看|幫你看看|我可以帮你看看|我可以幫你看看|we\s+(?:have|offer)|we|kami\s+(?:ada|mempunyai)|kami)$/iu;
 const independentInfo=/(?:RM\s*\d+|[39]\s*d|First\s+Trial|骨盆|疗程|療程|护理|護理|价钱|價錢|价格|價格|评估|評估|预约|預約|appointment|booking|treatment|rawatan|package|promo)/iu;
 const retained=clauses.map(part=>{
   if((choice||multiple)&&(UNNECESSARY_AREA.test(part)||misleadingArea.test(part)))return "";
   const bad=[FALSE_BRANCHES.exec(part),FALSE_BRANCH_CHOICE.exec(part)]
     .filter(Boolean).sort((a,b)=>a.index-b.index);
   if(!bad.length)return part;
   const first=bad[0],last=bad.at(-1);
   const before=part.slice(0,first.index).trim();
   const after=part.slice(last.index+last[0].length)
     .replace(/^[\s，,；;:：]+/u,"").trim();
   const keepBefore=before&&!emptyPreamble.test(before)?before:"";
   // A mixed clause can contain an independent price or booking statement
   // after the false claim. Retain it, but never retain dangling location
   // selection text or a bare conjunction.
   const keepAfter=after&&independentInfo.test(after)&&
     !misleadingArea.test(after)&&!FALSE_BRANCHES.test(after)&&
     !FALSE_BRANCH_CHOICE.test(after)
       ?after.replace(/^(?:但|不过|不過|and|but)\s*/iu,""):"";
   return [keepBefore,keepAfter].filter(Boolean).join(" ");
 }).join("").replace(/^[\s，,；;]+|[\s，,；;]+$/gu,"").trim();
 const final=retained&&retained.toLocaleLowerCase().includes(b.address.trim().toLocaleLowerCase())
   ?retained:[retained,fact].filter(Boolean).join("\n\n");
 return {reply:final,changed:final!==original};
}

module.exports = { appendRequestedBusinessFacts, correctUnsupportedBranchReply,
  isBusinessLocationQuestion, confirmedSingleBranchLocationAnswer, verifyLocationDraft, standaloneLocationQuestion, singleBranchLocationFacts };
