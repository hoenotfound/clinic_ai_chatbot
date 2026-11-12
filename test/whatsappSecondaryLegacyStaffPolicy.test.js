"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {secondaryLegacyStaffCutoff,secondaryLegacyStaffAudienceSql}=
 require("../src/services/whatsappSecondaryLegacyStaffPolicy");
const eligibility=require("../src/services/whatsappSecondaryAdsOnlyEligibility");
const recovery=require("../src/services/whatsapp131060Recovery");
const env={
 WHATSAPP_SECONDARY_LEGACY_STAFF_MODE_ENABLED:"true",
 WHATSAPP_SECONDARY_LEGACY_STAFF_ACTIVATED_AT:"2026-11-12T02:36:00Z",
 WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"all_contacts",
 WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:"2026-11-02T00:00:00Z",
 WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
 WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
 WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
};
test("legacy mode starts only after valid explicit cutover and fails closed otherwise",()=>{
 assert.equal(secondaryLegacyStaffCutoff({}),null);
 assert.equal(secondaryLegacyStaffCutoff(env),"2026-11-12T02:36:00.000Z");
 assert.equal(secondaryLegacyStaffAudienceSql("c","inbound",{}),"TRUE");
 assert.equal(secondaryLegacyStaffAudienceSql("c","inbound",{
  ...env,WHATSAPP_SECONDARY_LEGACY_STAFF_ACTIVATED_AT:"no-date"
 }),"FALSE");
 assert.equal(eligibility.secondaryAllContactReplyActivation({
  ...env,WHATSAPP_SECONDARY_LEGACY_STAFF_ACTIVATED_AT:"no-date"
 }),null);
 assert.throws(()=>secondaryLegacyStaffAudienceSql("c;DROP TABLE contacts","inbound",env));
});
test("old secondary contact is manual unless genuine new sender-bound ad was received",()=>{
 const sql=secondaryLegacyStaffAudienceSql("c","inbound",env);
 for(const expression of [
  /c.created_at>=/,/c.whatsapp_coexistence_imported_at IS NULL/,
  /old_contact_turn.source_created_at/,/whatsapp_free_entry_referrals verified_ad/,
  /verified_ad.source_type='ad'/,/verified_ad.ctwa_clid/,
  /verified_ad.meta_ad_id/,/ad_inbound.whatsapp_message_id IS NOT NULL/,
  /ad_context.conversation_id=ad_conversation.id/,
  /ad_inbound.source_created_at>=/,/ad_history.message_id=ad_inbound.id/,
  /inbound.created_at<ad_inbound.created_at\+INTERVAL '7 days'/,
  /inbound.source_created_at IS NOT NULL/
 ])assert.match(sql,expression);
 const ui=secondaryLegacyStaffAudienceSql("c",null,env);
 assert.match(ui,/NOW\(\)<ad_inbound.created_at\+INTERVAL '7 days'/);
 assert.doesNotMatch(ui,/AND inbound\\.created_at/);
});
test("all contact automation adds legacy staff guard without weakening provider or consent rules",()=>{
 // Explicit environment parameter allows SQL review without switching live flags.
 const sql=eligibility.secondaryLegacyStaffAudienceSql("c","inbound",env);
 assert.match(sql,/whatsapp_sender_message_context ad_context/);
 // Secondary marketing still applies treatment-specific consent; this helper
 // can only narrow an existing eligible candidate, never grant consent.
 assert.match(sql,/whatsapp_free_entry_referrals/);
});
test("131060 recovery only promotes an old contact with verified current ad proof",()=>{
 const source=recovery.canSend131060Recovery.toString();
 assert.match(source,/current_ad.origin_message_id=inbound.id/);
 assert.match(source,/job.incoming_payload->'attribution'->>'adId'/);
 assert.match(source,/job.incoming_payload->'attribution'->>'ctwaClid'/);
 assert.match(source,/current_ad.source_type='ad'/);
 assert.match(source,/job.incoming_payload->'unsupportedErrors'/);
 assert.match(source,/older.contact_id=c.id/);
});
