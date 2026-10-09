const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const contactsRepo = require("../src/db/contactsRepo");
const messagesRepo = require("../src/db/messagesRepo");
const pipelineRepo = require("../src/db/pipelineRepo");
const mediaStorage = require("../src/services/mediaStorageService");
const whatsapp = require("../src/services/whatsappService");
const templateService = require("../src/services/whatsappTemplateService");
const templateMedia = require("../src/services/whatsappTemplateMediaService");
const whatsappPolicy = require("../src/services/whatsappPolicyService");
const conversationStore = require("../src/utils/conversationStore");
const alertRepo = require("../src/db/telegramImmediateAlertRepo");
const followUpVideo = require("../src/services/followUpVideoPreparationService");
const router = require("../src/routes/conversations");

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
  "base64"
);

function patch(t, object, name, replacement) {
  const previous = object[name];
  object[name] = replacement;
  t.after(() => { object[name] = previous; });
}

async function harness(t, { format = "IMAGE", marketingAllowed = true } = {}) {
  const events = { r2Uploads: 0, metaUploads: 0, metaSends: 0, saved: [], deleted: 0 };
  const contact = {
    id: 7, contact_id: 7, channel: "whatsapp", whatsapp_number: "60111234567",
    mode: "human", needs_attention: false, is_unread: false, takeover_by: null,
  };
  const optInAt = "2026-10-09T00:00:00.000Z";
  const rawTemplate = {
    name: "clinic_test", language: "en_US", status: "APPROVED", category: "MARKETING",
    components: [
      { type: "HEADER", format },
      { type: "BODY", text: "Hello, this is our offer." },
    ],
  };
  const template = templateService.normalizeTemplate(rawTemplate);
  patch(t, contactsRepo, "getContactById", async () => contact);
  patch(t, whatsappPolicy, "checkTemplateAllowed", async () => marketingAllowed
    ? { allowed: true, state: { whatsapp_opt_in_at: optInAt } }
    : { allowed: false, code: "marketing_opted_out", message: "Marketing opted out" });
  patch(t, templateService, "resolveApprovedTemplate", async () => ({ success: true, template }));
  patch(t, alertRepo, "withContactAlertLock", async (_contactId, work) => work());
  patch(t, conversationStore, "appendMessageForContact",
    async (_contactId, role, preview, _wamid, _username, mediaUrl, mediaAttachment, options) => {
      const row = {
        id: 42, role, content: preview, media_url: mediaUrl,
        media_mime_type: mediaAttachment?.mimeType || null,
        media_key: options.mediaKey, whatsapp_template: options.whatsappTemplate,
        delivery_status: "unknown",
      };
      events.saved.push(row);
      return row;
    });
  patch(t, mediaStorage, "uploadMedia", async () => {
    events.r2Uploads += 1;
    return "messages/7/template-media.png";
  });
  patch(t, mediaStorage, "deleteMedia", async () => { events.deleted++; });
  patch(t, whatsapp, "uploadMedia", async (buffer, mime, filename) => {
    events.metaUploads++;
    assert.ok(buffer.length > 0);
    assert.ok(mime === "image/png" || mime === "video/mp4");
    assert.ok(filename);
    return "1234567";
  });
  patch(t, templateService, "sendApprovedTemplate", async (_contact, args) => {
    events.metaSends++;
    assert.equal(args.templateName, "clinic_test");
    const part = args.components.find((component) => component.type === "header");
    assert.equal(part.parameters[0].type, format.toLowerCase());
    assert.equal(part.parameters[0][format.toLowerCase()].id, "1234567");
    assert.equal(args.expectedOptInAt, optInAt);
    return { success: true, wamid: "wamid.test.media", unknown: false };
  });
  patch(t, messagesRepo, "setWhatsappMessageId", async (id, wamid) => ({
    id, whatsapp_message_id: wamid, delivery_status: "pending",
  }));
  patch(t, contactsRepo, "clearDeliveryAttentionIfNoFailedMessages", async () => {});
  patch(t, pipelineRepo, "markContactedForContact", async () => {});
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { username: "staff" }; next(); });
  app.use("/api/conversations", router);
  const server = await new Promise((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  t.after(() => server.close());
  return {
    events,
    template,
    retry: async (messageId = 42) => {
      const response = await fetch(
        "http://127.0.0.1:" + server.address().port + "/api/conversations/7/messages/" + messageId + "/retry",
        { method: "POST" }
      );
      return { status: response.status, body: await response.json() };
    },
    post: async (body) => {
      const response = await fetch(
        "http://127.0.0.1:" + server.address().port + "/api/conversations/7/whatsapp-templates/send",
        { method: "POST", body, ...(body instanceof FormData ? {} : {headers:{"Content-Type":"application/json"}}) },
      );
      return { status: response.status, body: await response.json() };
    },
  };
}

test("Inbox multipart image flow persists one R2 object then sends a Meta media header", async (t) => {
  const h = await harness(t);
  const form = new FormData();
  form.append("templateName", "clinic_test");
  form.append("languageCode", "en_US");
  form.append("values", JSON.stringify({ body: [] }));
  form.append("marketingConsentConfirmed", "true");
  form.append("media", new Blob([png], { type: "image/png" }), "offer.png");
  const result = await h.post(form);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(h.events.r2Uploads, 1);
  assert.equal(h.events.metaUploads, 1);
  assert.equal(h.events.metaSends, 1);
  assert.equal(h.events.saved.length, 1);
  assert.equal(h.events.saved[0].whatsapp_template.mediaFormat, "IMAGE");
  assert.equal(h.events.saved[0].media_key, "messages/7/template-media.png");
});

test("Inbox blocks forged MIME images before any storage or Meta call", async (t) => {
  const h = await harness(t);
  const form = new FormData();
  form.append("templateName", "clinic_test");
  form.append("languageCode", "en_US");
  form.append("marketingConsentConfirmed", "true");
  form.append("media", new Blob([Buffer.from("not a PNG")], { type: "image/png" }), "bad.png");
  const result = await h.post(form);
  assert.equal(result.status, 400);
  assert.equal(h.events.r2Uploads, 0);
  assert.equal(h.events.metaUploads, 0);
  assert.equal(h.events.metaSends, 0);
});

test("Inbox denies opted-out contacts before image upload or Meta send", async (t) => {
  const h = await harness(t, { marketingAllowed: false });
  const form = new FormData();
  form.append("templateName", "clinic_test");
  form.append("languageCode", "en_US");
  form.append("marketingConsentConfirmed", "true");
  form.append("media", new Blob([png], { type: "image/png" }), "offer.png");
  const result = await h.post(form);
  assert.equal(result.status, 403);
  assert.equal(h.events.r2Uploads, 0);
  assert.equal(h.events.metaUploads, 0);
  assert.equal(h.events.metaSends, 0);
});

test("Inbox reuses existing promotion image without duplicating a permanent R2 object", async (t) => {
  const h = await harness(t);
  patch(t, templateMedia, "resolveReusableMedia", async (id, format) => {
    assert.equal(id, "promo:30");
    assert.equal(format, "IMAGE");
    return { buffer: png, mimeType: "image/png", filename: "package.png",
      mediaKey: null, mediaUrl: "/promo-images/30", mediaSelectionId: id };
  });
  const result = await h.post(JSON.stringify({
    templateName: "clinic_test", languageCode: "en_US",
    marketingConsentConfirmed: true, values: {}, mediaSelectionId: "promo:30",
  }));
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(h.events.r2Uploads, 0);
  assert.equal(h.events.metaUploads, 1);
  assert.equal(h.events.metaSends, 1);
  assert.equal(h.events.saved[0].media_url, "/promo-images/30");
  assert.equal(h.events.saved[0].whatsapp_template.mediaSelectionId, "promo:30");
});

test("Inbox uses existing R2 video directly and checks codec before sending new uploads", async (t) => {
  const h = await harness(t, { format: "VIDEO" });
  patch(t, templateMedia, "resolveReusableMedia", async () => ({
    buffer: Buffer.from("safe-video"), mimeType: "video/mp4",
    filename: "feedback.mp4", mediaKey: "messages/follow-up-config/feedback.mp4",
    mediaUrl: null, mediaSelectionId: "video:trusted",
  }));
  const reused = await h.post(JSON.stringify({
    templateName: "clinic_test", languageCode: "en_US",
    marketingConsentConfirmed: true, values: {}, mediaSelectionId: "video:trusted",
  }));
  assert.equal(reused.status, 201, JSON.stringify(reused.body));
  assert.equal(h.events.r2Uploads, 0);
  assert.equal(h.events.saved[0].media_key, "messages/follow-up-config/feedback.mp4");
  patch(t, followUpVideo, "prepareFollowUpVideoFile", async (_filepath, options) => {
    assert.equal(options.ensureWhatsAppCompatible, true);
    return { buffer: Buffer.from("compatible-mp4") };
  });
  const form = new FormData();
  form.append("templateName", "clinic_test");
  form.append("languageCode", "en_US");
  form.append("marketingConsentConfirmed", "true");
  form.append("media", new Blob([Buffer.from("test-mp4")], { type: "video/mp4" }), "new.mp4");
  const uploaded = await h.post(form);
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  assert.equal(h.events.r2Uploads, 1);
  assert.equal(h.events.metaSends, 2);
});

test("Meta media upload failure deletes the orphan R2 upload without recording or sending a message", async (t) => {
  const h = await harness(t);
  patch(t, whatsapp, "uploadMedia", async () => null);
  const form = new FormData();
  form.append("templateName", "clinic_test");
  form.append("languageCode", "en_US");
  form.append("marketingConsentConfirmed", "true");
  form.append("media", new Blob([png], { type: "image/png" }), "offer.png");
  const response = await h.post(form);
  assert.equal(response.status, 502);
  assert.equal(h.events.r2Uploads, 1);
  assert.equal(h.events.deleted, 1);
  assert.equal(h.events.metaSends, 0);
  assert.equal(h.events.saved.length, 0);
});

test("Inbox retries an image template using its saved private R2 key", async (t) => {
  const h = await harness(t);
  const originalMediaKey = "messages/7/template-media.png";
  const savedRow = {
    id: 42, contact_id: 7, role: "assistant", delivery_status: "failed",
    sent_by_username: "staff", is_automated_follow_up: false,
    is_scheduled_message: false, media_key: originalMediaKey,
    media_mime_type: "image/png", media_filename: "offer.png",
    whatsapp_template: {
      name: "clinic_test", language: "en_US", category: "MARKETING",
      values: { header: [], body: [] }, mediaFormat: "IMAGE",
      mediaFilename: "offer.png", marketingConsentConfirmed: true,
      consentOptInAt: "2026-10-09T00:00:00.000Z",
      templateSignature: templateService.templateSignature(h.template),
    },
  };
  patch(t, messagesRepo, "acquireMessageRetryLock", async () => async () => {});
  patch(t, messagesRepo, "getMessageForRetry", async () => savedRow);
  patch(t, messagesRepo, "setDeliveryStatusById", async (id, status) => ({ id, delivery_status: status }));
  patch(t, mediaStorage, "downloadMedia", async (key) => {
    assert.equal(key, originalMediaKey);
    return png;
  });
  const result = await h.retry();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.accepted, true);
  assert.equal(h.events.metaUploads, 1);
  assert.equal(h.events.metaSends, 1);
  assert.equal(h.events.r2Uploads, 0);
});

test("Inbox blocks retries after WhatsApp marketing consent is withdrawn", async (t) => {
  const h = await harness(t, { marketingAllowed: false });
  patch(t, messagesRepo, "acquireMessageRetryLock", async () => async () => {});
  patch(t, messagesRepo, "getMessageForRetry", async () => ({
    id: 42, contact_id: 7, role: "assistant", delivery_status: "failed",
    sent_by_username: "staff",
    whatsapp_template: { name: "clinic_test", language: "en_US", mediaFormat: "IMAGE" },
  }));
  const result = await h.retry();
  assert.equal(result.status, 403);
  assert.equal(h.events.metaUploads, 0);
  assert.equal(h.events.metaSends, 0);
});

test("Inbox rejects forged shared media IDs without sending a template", async (t) => {
  const h = await harness(t);
  const result = await h.post(JSON.stringify({
    templateName: "clinic_test", languageCode: "en_US",
    marketingConsentConfirmed: true, values: {},
    mediaSelectionId: "video:invalid-tenant-video",
  }));
  assert.equal(result.status, 400);
  assert.equal(h.events.r2Uploads, 0);
  assert.equal(h.events.metaUploads, 0);
  assert.equal(h.events.metaSends, 0);
});
