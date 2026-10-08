const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const gemini = require("../src/services/geminiService");
const claude = require("../src/services/claudeService");
const { buildSystemPrompt } = require("../src/utils/systemPrompt");
const { promptPrefixFingerprint } = require("../src/services/aiUsageService");

async function withConfig(overrides, work) {
  const saved = JSON.parse(JSON.stringify(config));
  try {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, saved, overrides);
    return await work();
  } finally {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, saved);
  }
}

function clinicFixture() {
  return {
    businessName: "TCM Prefix Test",
    clinicName: "TCM Prefix Test",
    aiAssistantName: "Service Agent",
    businessType: "tcm_clinic",
    businessDescription: "Malaysian TCM service centre",
    messagingStyle: "Warm, concise Malaysian Chinese, English and Bahasa Malaysia; say 中医师.",
    services: [
      {name:"骨盆调理",description:"PELVIS_GUIDANCE",priceRange:"PELVIS_PRICE RM388",duration:"90 minutes"},
      {name:"3D 小颜术",description:"THREED_GUIDANCE",priceRange:"THREED_PRICE RM488",duration:"90 minutes"},
      {name:"9D 逆龄抗衰",description:"NINED_GUIDANCE",priceRange:"NINED_PRICE RM588",duration:"90 minutes"},
    ],
    serviceAliases:[
      {alias:"pelvis / 骨盆",officialService:"骨盆调理"},
      {alias:"3D / 小颜",officialService:"3D 小颜术"},
      {alias:"9D / 逆龄",officialService:"9D 逆龄抗衰"},
    ],
    promotions:[
      {name:"Pelvis Packages",linkedService:"骨盆调理",sendOnPriceQuery:true,packages:[
        {name:"Package A",aliases:["A套餐"],caption:"A_PROMO RM388 after RM100 voucher"},
        {name:"Package B",aliases:["B套餐"],caption:"B_PROMO RM288"},
      ]},
      {name:"3D Trial",linkedService:"3D 小颜术",sendOnPriceQuery:true,caption:"3D_PROMO RM488"},
    ],
    branches:[{name:"PJ",address:"PJ_ADDRESS_SENTINEL",phone:"+60 12 000 0000"}],
    hours:{general:"HOURS_SENTINEL 10am-7pm"},
    faqs:Array.from({length:80},(_,i)=>({q:`Shared FAQ ${i} on care and expectations?`,a:"Staff confirm clinical suitability and treatment frequency. ".repeat(3)})),
    guardrails:Array.from({length:28},(_,i)=>`Guardrail ${i}: Never promise guaranteed medical outcomes. Confirm any appointments with clinic staff.`),
  };
}

test("constant FAQ/guardrail prefix comes before service-specific sections and stays identical",async()=>{
  await withConfig(clinicFixture(),async()=>{
    const pelvicMessages=[{role:"user",content:"骨盆调理价钱多少？"}];
    const faceMessages=[{role:"user",content:"3D 小颜术 how much?"}];
    const p=gemini.buildGeminiRequest(pelvicMessages,{surface:"conversation",channel:"whatsapp"},"gemini-3.8-flash");
    const f=gemini.buildGeminiRequest(faceMessages,{surface:"conversation",channel:"whatsapp"},"gemini-3.8-flash");
    const a=p.request.config.systemInstruction;
    const b=f.request.config.systemInstruction;
    assert.ok(a.indexOf("FREQUENTLY ASKED QUESTIONS:") < a.indexOf("BUSINESS INFO:"));
    assert.ok(a.indexOf("RULES (never break these):") < a.indexOf("BUSINESS INFO:"));
    assert.equal((a.match(/FREQUENTLY ASKED QUESTIONS:/g)||[]).length,1);
    assert.equal((a.match(/RULES \\(never break these\\):/g)||[]).length,1);
    assert.notEqual(a,b,"service-aware prompt detail must remain distinct");
    assert.equal(promptPrefixFingerprint(p.request),promptPrefixFingerprint(f.request),"shared long prefix must remain identical");
    assert.match(a,/PELVIS_PRICE RM388/);
    assert.doesNotMatch(a,/THREED_GUIDANCE/);
    assert.match(b,/THREED_PRICE RM488/);
    assert.doesNotMatch(b,/PELVIS_GUIDANCE/);
    assert.equal(p.request.contents.length,pelvicMessages.length);
    assert.equal(f.request.contents[0].parts[0].text,faceMessages[0].content);
  });
});

test("package comparisons and location remain in the prompt after prefix reordering",async()=>{
  await withConfig(clinicFixture(),async()=>{
    const p=buildSystemPrompt({
      channel:"whatsapp",
      conversationContext:{relevantServiceNames:["骨盆调理"],promotionIntent:true,schedulingIntent:true,contactIntent:false},
    });
    for(const fact of ["Package A","Package B","RM100 voucher","RM388","RM288","PJ_ADDRESS_SENTINEL","HOURS_SENTINEL","PELVIS_GUIDANCE"])
      assert.ok(p.includes(fact),`Missing authoritative context: ${fact}`);
    assert.ok(p.indexOf("RULES (never break these):") < p.indexOf("ACTIVE PROMOTIONS"));
  });
});

test("Gemini and Claude receive the same reordered prompt for multilingual treatment switching",async()=>{
  await withConfig(clinicFixture(),async()=>{
    const conversation=[
      {role:"user",content:"想了解骨盆调理"},
      {role:"assistant",content:"想改善什么呢？"},
      {role:"user",content:"我现在想问3D 小颜术的价钱，可以星期六3pm吗？"},
    ];
    const expected=gemini.buildGeminiRequest(conversation,{surface:"conversation",channel:"whatsapp"},"gemini-3.8-flash");
    let sentBody=null;
    const answer=await claude.getReply(conversation,
      {surface:"conversation",channel:"whatsapp"},
      "test-key",null,{
        fetchImpl:async(url,options)=>{
          sentBody=JSON.parse(options.body);
          return {ok:true,text:async()=>JSON.stringify({content:[{type:"text",text:'{"reply":"好的","outcome":"normal"}'}],stop_reason:"end_turn"})};
        },
      });
    assert.match(answer,/好的/);
    assert.equal(sentBody.system,expected.request.config.systemInstruction);
    assert.match(sentBody.system,/THREED_PRICE RM488/);
    assert.match(sentBody.system,/PJ_ADDRESS_SENTINEL/);
    assert.match(sentBody.system,/HOURS_SENTINEL/);
    assert.doesNotMatch(sentBody.system,/PELVIS_GUIDANCE/);
    assert.equal(sentBody.messages.length,conversation.length);
  });
});
