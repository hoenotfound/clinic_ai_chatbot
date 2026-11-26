"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { resolveCompactConversationPolicy, selectCompactFAQs, resolveProductionCompactPolicy } = require("../src/utils/compactConversationPolicy");
const { requestFor } = require("../scripts/neutro-ab");
const { getIndustryProfile } = require("../src/config/industryProfiles");
const proposal = require("../scripts/config-proposals/neutro-prompt-consolidation-stage2.json");
const hash = text => createHash("md5").update(text,"utf8").digest("hex");
const faqs = [
  {q:"3D duration?",a:"90 minutes"},
  {q:"9D duration?",a:"120 minutes"},
  {q:"General safety?",a:"Seek review."},
  {q:"New question?",a:"New answer."}
];
const original = {...getIndustryProfile("tcm_clinic"), businessName:proposal.clinic, clinicName:proposal.clinic,
  services:[{name:"3D 小颜术",description:"Manual facial care"},{name:"9D 逆龄抗衰",description:"Device-based care"}],
  serviceAliases:[], faqs, guardrails:["Long original guardrail ".repeat(30)],
  escalation:{outOfScopeTriggers:["Long original trigger ".repeat(30)]}};
const plan={...proposal,
  expectedMd5:{guardrails:hash(original.guardrails.join("\n")),triggers:hash(original.escalation.outOfScopeTriggers.join("\n"))},
  guardrails:["Preserve safety; compact test marker"],triggers:["Review when needed; compact trigger marker"],
  faqScopes:{[hash("3D duration?\n90 minutes")]:"3D 小颜术",[hash("9D duration?\n120 minutes")]:"9D 逆龄抗衰"}};
const context={serviceSource:"current_customer",relevantServiceNames:["3D 小颜术"]};

test("compact proposal requires exact clinic and source fingerprints",()=>{
  assert.equal(resolveCompactConversationPolicy(original,plan),plan);
  assert.equal(resolveCompactConversationPolicy(original,null),null);
  assert.equal(resolveCompactConversationPolicy({...original,businessName:"Different clinic"},plan),null);
  assert.equal(resolveCompactConversationPolicy({...original,guardrails:[...original.guardrails,"new rule"]},plan),null);
  assert.equal(resolveCompactConversationPolicy({...original,escalation:{outOfScopeTriggers:["edited"]}},plan),null);
});
test("FAQ scoping preserves general, unknown, edited and relevant FAQs",()=>{
  assert.deepEqual(selectCompactFAQs(faqs,context,plan),[faqs[0],faqs[2],faqs[3]]);
  const changed=[...faqs.slice(0,1),{...faqs[1],a:"Updated answer"},...faqs.slice(2)];
  assert.deepEqual(selectCompactFAQs(changed,context,plan),changed);
  for(const c of [null,{...context,serviceSource:"meta_ad"},{...context,serviceSource:"recent_customer"},
    {...context,relevantServiceNames:["3D 小颜术","9D 逆龄抗衰"]},{...context,schedulingIntent:true},
    {...context,broadPriceIntent:true},{...context,serviceDiscoveryIntent:true},{...context,contactIntent:true}])
    assert.deepEqual(selectCompactFAQs(faqs,c,plan),faqs);
});
test("A/B prompt builder opts in only for candidate; standard follow-up unaffected",()=>{
  const scenario={surface:"conversation",channel:"whatsapp",lang:"zh",history:[{role:"user",content:"3D 小颜术"}]};
  const a=requestFor(original,scenario).config.systemInstruction;
  const b=requestFor(original,scenario,plan).config.systemInstruction;
  assert.match(a,/Long original guardrail/);
  assert.doesNotMatch(a,/compact test marker/);
  assert.match(b,/compact test marker/);
  assert.match(b,/compact trigger marker/);
  assert.match(b,/STRUCTURED OUTPUT/);
  assert.match(b,/"priceQuery": false/);
  assert.match(b,/"projectLocation"/);
  assert.ok(b.length<a.length);
  const follow={...scenario,surface:"follow_up",followUpContext:{stepNumber:1,treatmentInterest:"3D 小颜术"}};
  assert.equal(requestFor(original,follow,plan).config.systemInstruction,
    requestFor(original,follow).config.systemInstruction);
});
test("reviewed production compact policy retains specific safety and business exceptions",()=>{
  const g=proposal.guardrails.join("\n"), e=proposal.triggers.join("\n");
  for(const regex of [/6 weeks/,/KKM/,/pacemaker/,/Before & After/,/Package C/,/7合1/,/AI|keys/,/子宫调理/,/草药胸部/,/pregnancy/,/HIFU/,/no rebound/,/courtesy/i]) assert.match(g,regex);
  for(const regex of [/facial droop/,/diastasis recti/,/lochia/,/C-section/,/fourth month/,/incontinence/,/pacemaker/,/HIFU/,/medication/,/general postpartum/]) assert.match(e,regex);
});

test("rollout requires explicit boolean and every reviewed source fingerprint; no stored config mutation",()=>{
  const cfg={...original,sop:"old SOP",messagingStyle:"old style",closingPlaybook:"old closing"};
  const stage1={clinic:plan.clinic,expectedMd5:Object.fromEntries(["sop","messagingStyle","closingPlaybook"].map(k=>[k,hash(cfg[k])])),
    replacement:{sop:"S",messagingStyle:"M",closingPlaybook:"C"}};
  assert.equal(resolveProductionCompactPolicy(cfg,plan,stage1),null);
  assert.equal(resolveProductionCompactPolicy({...cfg,promptOptimization:{neutroCompactV2:"true"}},plan,stage1),null);
  const enabled={...cfg,promptOptimization:{neutroCompactV2:true}};
  const before=structuredClone(enabled);
  assert.deepEqual(resolveProductionCompactPolicy(enabled,plan,stage1).replacement,stage1.replacement);
  assert.equal(resolveProductionCompactPolicy({...enabled,sop:"changed"},plan,stage1),null);
  assert.equal(resolveProductionCompactPolicy({...enabled,promptOptimization:{neutroCompactV2:false}},plan,stage1),null);
  assert.deepEqual(enabled,before);
});
test("compact candidate explicitly prioritizes technical review, rejected appointment and media safety",()=>{
  const scenario={surface:"conversation",channel:"whatsapp",lang:"zh",history:[{role:"user",content:"3D 小颜术"}]};
  const prompt=requestFor(original,scenario,plan).config.systemInstruction;
  assert.match(prompt,/FINAL DECISION CONSISTENCY/);
  assert.match(prompt,/unverified technical specification/);
  assert.match(prompt,/appointmentPreference null/);
  assert.match(prompt,/serviceQuery false/);
  assert.match(prompt,/Never tell the customer that photos/);
});
test("ambiguous and multi-treatment context keeps all FAQs",()=>{
  for (const c of [
    {...context,serviceDiscoveryIntent:true},
    {...context,relevantServiceNames:["3D 小颜术","9D 逆龄抗衰"]},
    {...context,serviceSource:"conversation"},
    {...context,serviceSource:"meta_ad"},
    {...context,serviceSource:"current_promotion"}
  ]) assert.deepEqual(selectCompactFAQs(faqs,c,plan),faqs);
});


test("reviewed November 26 variant preserves changed clinic facts and rejects unknown drift",()=>{
  const revised=require("../scripts/config-proposals/neutro-prompt-consolidation-20261126.json");
  assert.equal(revised.clinic,proposal.clinic);
  assert.notDeepEqual(revised.expectedMd5,require("../scripts/config-proposals/neutro-prompt-consolidation-20261124.json").expectedMd5);
  assert.match(revised.replacement.sop,/Pulse Wave is a whole-body treatment, not a localized treatment/);
  assert.match(revised.replacement.sop,/additional attention to specific areas/);
  assert.match(revised.replacement.sop,/KKM-certified TCM practitioners and 25 years/);
  assert.match(revised.replacement.sop,/深入15cm/);
  assert.match(revised.replacement.sop,/不得主动重复或保证/);
  assert.match(revised.replacement.messagingStyle,/do not promise AI 身体检测/i);
  assert.match(revised.replacement.closingPlaybook,/Package A's AI 身体检测/);
  // A real source edit cannot select either reviewed revision.
  assert.equal(resolveProductionCompactPolicy({...original,promptOptimization:{neutroCompactV2:true},
    sop:"edited",messagingStyle:"edited",closingPlaybook:"edited"},plan),null);
});
