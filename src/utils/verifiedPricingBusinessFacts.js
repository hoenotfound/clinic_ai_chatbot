"use strict";

// Append *configured* business facts only when the current customer message
// asks a second administrative question alongside verified treatment pricing.
// Never derive an address from Gemini, an ad, CRM labels or older chat history.
// Only an actual request for the BUSINESS location may append a branch
// address. "位置" (body position), English "located" (symptom location)
// and generic Malay "kat mana" are NOT sufficient by themselves.
const BUSINESS_LOCATION_ZH =
  /(?:地址|地[点點](?:\\s*[?？]|.{0,8}(?:在哪(?:里|裡|儿|兒)?|哪[里裡]|位置))|(?:诊所|診所|门店|門店|中心|分行|店面|店址|店铺|店舖|贵店|貴店|你们|你們|你家|你那边|你那邊|你们那边|你們那邊).{0,16}(?:在哪(?:里|裡|儿|兒)?|哪[里裡]|位置|怎么去|怎麼去)|(?:在哪(?:里|裡|儿|兒)?|哪[里裡]).{0,16}(?:诊所|診所|门店|門店|中心|分行|店面|店址|店铺|店舖))/iu;
const BUSINESS_LOCATION_EN =
  /\b(?:address|directions|(?:your|the|this|clinic|centre|center|branch|outlet|shop|store|business)\s+location|where\s+(?:are\s+you(?:\s+located)?|is\s+(?:(?:your|the|this)\s+)?(?:clinic|centre|center|branch|outlet|shop|store|business)(?:\s+located)?)|where\s+can\s+i\s+find\s+you|(?:your|the)\s+(?:clinic|centre|center|branch|outlet)\s+(?:address|location)|(?:clinic|centre|center|branch|outlet)\s+near\s+me)\b/iu;
const BUSINESS_LOCATION_MS =
  /\b(?:alamat|lokasi\s+(?:klinik|pusat|cawangan|kedai|anda|awak|kamu)|(?:klinik|pusat|cawangan|kedai)\s+(?:di\s+mana|dimana|kat\s+mana)|(?:di\s+mana|dimana|kat\s+mana)\s+(?:klinik|pusat|cawangan|kedai))\b/iu;

const HOURS_QUESTION =
  /(?:营业时间|營業時間|营业到几点|營業到幾點|几点开|幾點開|几点关|幾點關|几时开|幾時開|几时关|幾時關|开门时间|開門時間|\b(?:opening hours|business hours|operating hours|what time (?:do you )?(?:open|close)|when (?:do you )?(?:open|close)|waktu operasi|waktu buka|jam buka|masa operasi|pukul berapa (?:buka|tutup))\b)/iu;

function appendRequestedBusinessFacts({
  customerText = "", reply = "", branches = [], hours = null, language = "zh",
} = {}) {
  const current = String(customerText || "");
  const source = String(reply || "");
  if (!current.trim() || !source.trim()) return source;

  const wantsLocation = BUSINESS_LOCATION_ZH.test(current) ||
    BUSINESS_LOCATION_EN.test(current) || BUSINESS_LOCATION_MS.test(current);
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

module.exports = { appendRequestedBusinessFacts };
