const test = require("node:test");
const assert = require("node:assert/strict");
const { pool } = require("../src/db/db");
const clinicConfig = require("../src/config/clinicConfig");
const worker = require("../src/services/whatsappFreeEntryFollowUpService");
const templates = require("../src/services/whatsappTemplateService");
const whatsapp = require("../src/services/whatsappService");
const images = require("../src/db/promoImagesRepo");
const templateMedia = require("../src/services/whatsappTemplateMediaService");
const messages = require("../src/db/messagesRepo");
const events = require("../src/utils/realtimeEvents");

test("extended follow-up builds and sends only approved treatment-matched image + variable without a live API call", async (t) => {
  const keys = ["WHATSAPP_FEP_FOLLOWUPS_ENABLED", "AUTOMATED_REPLIES_ENABLED"];
  const savedEnv = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) process.env[k] = "true";
  t.after(() => {
    for (const k of keys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });
  const original = {
    query: pool.query, connect: pool.connect, auto: clinicConfig.automatedFollowUp,
    services: clinicConfig.services, promotions: clinicConfig.promotions,
    upload: whatsapp.uploadMedia, fetchImage: images.getPublicImage,
    prepare: templateMedia.prepareImage, send: templates.sendApprovedTemplate,
    save: messages.saveMessage, setId: messages.setWhatsappMessageId,
    publish: events.publish,
  };
  t.after(() => {
    pool.query = original.query;
    pool.connect = original.connect;
    clinicConfig.automatedFollowUp = original.auto;
    clinicConfig.services = original.services;
    clinicConfig.promotions = original.promotions;
    whatsapp.uploadMedia = original.upload;
    images.getPublicImage = original.fetchImage;
    templateMedia.prepareImage = original.prepare;
    templates.sendApprovedTemplate = original.send;
    messages.saveMessage = original.save;
    messages.setWhatsappMessageId = original.setId;
    events.publish = original.publish;
  });
  clinicConfig.services = [{ name: "3D 小颜术" }];
  clinicConfig.promotions = [{
    name: "3D First Trial", linkedService: "3D 小颜术",
    validFrom: "2026-10-01", validUntil: "2026-10-31",
    imageUrl: "https://clinic.example/promo-images/32",
  }];
  clinicConfig.automatedFollowUp = {
    enabled: true, quietHours: { enabled: false },
    freeEntry: {enabled: true, activatedAt: "2026-10-08T00:00:00Z",
      templateName: "ns_fu_pricing_graphic", language: "zh_CN",
      fallbackLanguage: "zh_CN", slotsHours: [26], templateRules: []},
  };
  const now = new Date("2026-10-09T04:00:00Z");
  const firstReply = new Date(now.getTime() - 26.2 * 3600000);
  const firstInbound = new Date(firstReply.getTime() - 2 * 60000);
  const candidate = {
    contact_id: 17, whatsapp_number: "60123456789",
    whatsapp_opt_in_at: "2026-10-08T00:00:00Z",
    first_inbound_at: firstInbound, first_reply_at: firstReply,
    first_reply_message_id: 44, last_inbound_at: firstInbound,
    source_is_ctwa: true, evidence_type: "free_entry_point",
    treatment_interest: "3D 小颜术",
    referral_treatment_interest: "3D 小颜术",
    referral_ad_name: "3D 小颜术",
    recent_inbound_messages: ["想了解 Neutro Sense TCM 3D 小颜术"],
    claimed_slots: [], used_template_names: [],
    lead_started_message_id: 12, latest_ad_message_id: 12,
  };
  const template = templates.normalizeTemplate({
    name: "ns_fu_pricing_graphic", language: "zh_CN",
    category: "MARKETING", status: "APPROVED", components: [
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "Neutro Sense TCM {{1}} 的配套优惠" },
    ],
  });
  const dbCalls = [], providerCalls = [], savedMessages = [];
  pool.query = async (sql, params = []) => {
    dbCalls.push({ sql, params });
    if (sql.includes("FROM contacts c")) return { rows: [candidate] };
    if (sql.includes("INSERT INTO whatsapp_free_entry_followup_attempts")) {
      return { rows: [{ id: 123 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  pool.connect = async () => ({ query: (...args) => pool.query(...args), release() {} });
  images.getPublicImage = async (id) => {
    assert.equal(id, 32);
    return { mime_type: "image/png", data: Buffer.from("safe-image").toString("base64") };
  };
  templateMedia.prepareImage = async (buffer, mime) => {
    assert.equal(mime, "image/png");
    assert.ok(buffer.length > 0);
    return buffer;
  };
  whatsapp.uploadMedia = async (buffer,mime,filename) => {
    providerCalls.push({type:"upload",mime,filename,bytes:buffer.length});
    return "123456789";
  };
  templates.sendApprovedTemplate = async (_contact, data) => {
    providerCalls.push({type:"send",data});
    return {success:true,wamid:"wamid.mocked-accepted"};
  };
  messages.saveMessage = async (...args) => {
    savedMessages.push(args);
    return { id: 701 };
  };
  messages.setWhatsappMessageId = async () => {};
  events.publish = () => {};
  const active = worker.settings();
  assert.ok(active, "worker configuration passes all normal guards");
  const result = await worker.processCandidate(candidate,active,template,now);
  assert.equal(result, "accepted");
  assert.deepEqual(providerCalls.map(item=>item.type),["upload","send"]);
  assert.equal(providerCalls[0].mime,"image/png");
  assert.equal(providerCalls[1].data.templateCategory,"MARKETING");
  assert.deepEqual(providerCalls[1].data.components[0],{
    type:"header",parameters:[{type:"image",image:{id:"123456789"}}]
  });
  assert.deepEqual(providerCalls[1].data.components[1],{
    type:"body",parameters:[{type:"text",text:"3D 小颜术"}]
  });
  assert.equal(savedMessages.length,1);
  assert.equal(savedMessages[0][5],"/promo-images/32");
  const savedTemplate = savedMessages[0][8].whatsappTemplate;
  assert.equal(savedTemplate.values.body[0],"3D 小颜术");
  assert.equal(savedTemplate.components[0].parameters[0].image.id,"123456789");
  assert.ok(dbCalls.some(row=>row.sql.includes("pg_advisory_xact_lock")));
  assert.ok(dbCalls.some(row=>row.sql.includes("UPDATE whatsapp_free_entry_followup_attempts")));
});
