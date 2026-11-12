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
test("verified pre-cutover ads require a fresh readable, sender-bound inbound before seven-day expiry",()=>{
 const anchored=secondaryLegacyStaffAudienceSql("c","inbound",env);
 for(const fragment of [
  /whatsapp_free_entry_referrals prior_ad/,
  /prior_ad.source_type='ad'/,
  /ad_inbound.created_at<'2026-11-12T02:36:00.000Z'::timestamptz/,
  /ad_inbound.source_created_at<'2026-11-12T02:36:00.000Z'::timestamptz/,
  /NOW\(\)<ad_inbound.created_at\+INTERVAL '7 days'/,
  /inbound.created_at>='2026-11-12T02:36:00.000Z'::timestamptz/,
  /inbound.source_created_at>='2026-11-12T02:36:00.000Z'::timestamptz/,
  /inbound.id>ad_inbound.id/,
  /NULLIF\(BTRIM\(inbound.content\),''\) IS NOT NULL/,
  /inbound.content NOT LIKE '📎 \[%'/,
  /renewed_context.message_id=inbound.id/,
  /renewed_history.message_id=inbound.id/,
  /prior_context.message_id=ad_inbound.id/,
  /ad_conversation.customer_wa_id=c.whatsapp_number/,
 ])assert.match(anchored,fragment);
 const listing=secondaryLegacyStaffAudienceSql("c",null,env);
 assert.match(listing,/FROM messages renewed_inbound/);
 assert.match(listing,/renewed_inbound.id>ad_inbound.id/);
 assert.match(listing,/renewed_inbound.content NOT LIKE '📎 \[%'/);
 assert.match(listing,/NULLIF\(BTRIM\(renewed_inbound.content\),''\) IS NOT NULL/);
 assert.match(listing,/renewed_context.message_id=renewed_inbound.id/);
 assert.doesNotMatch(secondaryLegacyStaffAudienceSql("c","inbound",{}),/prior_ad/);
});

test("all contact automation adds legacy staff guard without weakening provider or consent rules",()=>{
 // Explicit environment parameter allows SQL review without switching live flags.
 const sql=eligibility.secondaryLegacyStaffAudienceSql("c","inbound",env);
 assert.match(sql,/whatsapp_sender_message_context ad_context/);
 const automation=eligibility.secondaryAutomationEligibleSql("c","$6","inbound","$7","$8",env);
 assert.match(automation,/whatsapp_free_entry_referrals verified_ad/);
 assert.match(automation,/inbound.created_at<ad_inbound.created_at\+INTERVAL '7 days'/);
 // Secondary marketing still applies treatment-specific consent; this helper
 // can only narrow an existing eligible candidate, never grant consent.
 assert.match(sql,/whatsapp_free_entry_referrals/);
});

test("manual AI approval expires in seven days and cannot authorize pre-approval follow-up anchors",()=>{
 const sql=secondaryLegacyStaffAudienceSql("c","inbound",env);
 assert.match(sql,/c.whatsapp_secondary_manual_ai_approved_until > NOW\(\)/);
 assert.match(sql,/inbound.source_created_at >= date_trunc\('second', c.whatsapp_secondary_manual_ai_approved_at\)/);
 assert.match(sql,/inbound.created_at >= c.whatsapp_secondary_manual_ai_approved_at/);
 assert.match(sql,/inbound.created_at < c.whatsapp_secondary_manual_ai_approved_until/);
 assert.match(sql,/inbound.role='user'/);
 assert.match(sql,/inbound.whatsapp_message_id IS NOT NULL/);
 const visible=secondaryLegacyStaffAudienceSql("c",null,env);
 assert.match(visible,/c.whatsapp_secondary_manual_ai_approved_until > NOW\(\)/);
 assert.doesNotMatch(visible,/inbound.created_at >= c.whatsapp_secondary_manual_ai_approved_at/);
 assert.doesNotMatch(secondaryLegacyStaffAudienceSql("c","inbound",{}),/whatsapp_secondary_manual_ai/);
});

test("131060 recovery does not invent ad attribution but restores AI after accepted menu and a readable reply",()=>{
 const {secondary131060RecoveryAudienceSql}=
   require("../src/services/whatsappSecondaryLegacyStaffPolicy");
 const enabled={...env,
   WHATSAPP_SECONDARY_131060_RECOVERY_ENABLED:"true",
   WHATSAPP_SECONDARY_131060_RECOVERY_ACTIVATED_AT:"2026-11-12T02:36:00Z",
 };
 const sql=secondary131060RecoveryAudienceSql("c","inbound",enabled);
 assert.match(sql,/inbound\.id>recovery_menu\.id/);
 assert.match(sql,/outbound_message_evidence accepted_menu/);
 assert.match(sql,/accepted_menu\.accepted=TRUE/);
 assert.match(sql,/accepted_menu\.provider_message_id=recovery_menu\.whatsapp_message_id/);
 assert.match(sql,/unavailable131060\.content LIKE/);
 assert.match(sql,/inbound\.content NOT LIKE/);
 assert.match(sql,/inbound\.created_at<recovery_menu\.created_at\+INTERVAL '7 days'/);
 assert.match(sql,/recorded131060\.incoming_payload->'unsupportedErrors'/);
 assert.doesNotMatch(sql,/whatsapp_free_entry_referrals/);
 assert.equal(secondary131060RecoveryAudienceSql("c","inbound",env),"FALSE");
 assert.equal(secondary131060RecoveryAudienceSql("c","inbound",{
  ...enabled, WHATSAPP_SECONDARY_131060_RECOVERY_ACTIVATED_AT:"invalid"
 }),"FALSE");
 const first=require("../src/services/whatsapp131060Recovery").canSend131060Recovery.toString();
 assert.match(first,/prior_evidence/);
 assert.match(first,/job\.incoming_payload->'unsupportedErrors'/);
 assert.doesNotMatch(first,/current_ad\.source_type='ad'/);
});
