"use strict";

// Append *configured* business facts only when the current customer message
// asks a second administrative question alongside verified treatment pricing.
// Never derive an address from Gemini, an ad, CRM labels or older chat history.
const LOCATION_QUESTION =
  /(?:地点|地點|地址|位置|在哪里|在哪裡|哪里有|哪裡有|怎么去|怎麼去|分行|门店|門店|诊所在哪|診所在哪|\b(?:address|location|located|directions|which branch|where (?:are you|is (?:your|the) (?:clinic|centre|center|branch)))\b|\b(?:alamat|lokasi|di mana|dimana|kat mana|cawangan)\b)/iu;
const HOURS_QUESTION =
  /(?:营业时间|營業時間|营业到几点|營業到幾點|几点开|幾點開|几点关|幾點關|几时开|幾時開|几时关|幾時關|开门时间|開門時間|\b(?:opening hours|business hours|operating hours|what time (?:do you )?(?:open|close)|when (?:do you )?(?:open|close)|waktu operasi|waktu buka|jam buka|masa operasi|pukul berapa (?:buka|tutup))\b)/iu;

function appendRequestedBusinessFacts({
  customerText = "", reply = "", branches = [], hours = null, language = "zh",
} = {}) {
  const current = String(customerText || "");
  const source = String(reply || "");
  if (!current.trim() || !source.trim()) return source;

  const wantsLocation = LOCATION_QUESTION.test(current);
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
