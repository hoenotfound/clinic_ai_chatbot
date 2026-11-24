"use strict";

// Narrow factual safety backstop, not a treatment selector or reply generator.
// Only applies to the exact clinic, explicitly named pulse wave, a direct
// depth question, and the current explicit unverified-depth service policy.
function needsUnverifiedPulseDepthReview(config, text) {
  if (config?.businessType !== "tcm_clinic" ||
      (config.businessName || config.clinicName) !== "Neutro Sense TCM Centre") return false;
  const service = config.services?.find(s => s.name === "脉冲波调理");
  if (!service || !String(service.description || "").includes("设备型号与作用深度没有经核实的技术资料")) return false;
  const value = String(text || "").normalize("NFKC");
  if (!/(?:脉冲波|脈衝波|pulse\s*wave|gelombang\s*nadi)/iu.test(value)) return false;
  return /(?:深入|穿透|深达|深達|作用深度|深度).{0,15}(?:几|幾|多少|多深|\d+\s*(?:cm|公分|厘米))|(?:几|幾|多少).{0,8}(?:公分|厘米|cm).{0,12}(?:深入|穿透|深度)|\b(?:how\s+deep|penetration\s+depth|depth\s+of\s+penetration|penetrate.{0,16}(?:cm|centimetres?|centimeters?))\b|\b(?:berapa\s+(?:dalam|kedalaman)|kedalaman.{0,12}(?:cm|sentimeter))\b/iu.test(value);
}
module.exports = {needsUnverifiedPulseDepthReview};
