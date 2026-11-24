"use strict";

// Operator-only, deployment-local, time-limited override. Never set global
// clinicConfig for a single conversation. Database contact IDs are sender
// specific; only one exact WhatsApp contact may be selected.
function resolveContactPricingMode({baseMode,contactId,channel,env=process.env,now=Date.now()}={}) {
  const mode=baseMode || "off";
  if(mode!=="shadow" || channel!=="whatsapp") return mode;
  const id=String(contactId??"");
  const allowed=String(env.AI_PRICING_TEST_CONTACT_ID??"");
  const expiry=String(env.AI_PRICING_TEST_EXPIRES_AT??"");
  if(!/^[1-9]\d{0,14}$/u.test(id) || id!==allowed ||
     !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(expiry)) return mode;
  const until=Date.parse(expiry);
  if(!Number.isFinite(now) || !Number.isFinite(until) ||
     until<=now || until-now>24*60*60*1000) return mode;
  return "enabled";
}

module.exports={resolveContactPricingMode};
