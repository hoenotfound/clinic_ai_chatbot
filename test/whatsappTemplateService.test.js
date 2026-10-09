const test = require("node:test");
const assert = require("node:assert/strict");

const templateService = require("../src/services/whatsappTemplateService");
const whatsappPolicy = require("../src/services/whatsappPolicyService");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("loads only approved WhatsApp templates and exposes positional text variables", async () => {
  templateService.clearTemplateCache();

  const result = await templateService.listApprovedTemplates({
    env: {
      WHATSAPP_WABA_ID: "waba-1",
      WHATSAPP_TOKEN: "token-1",
    },
    fetchImpl: async (url, options) => {
      assert.match(url, /waba-1\/message_templates/);
      assert.equal(options.headers.Authorization, "Bearer token-1");
      return jsonResponse({
        data: [
          {
            id: "1",
            name: "lead_follow_up",
            language: "en_US",
            status: "APPROVED",
            category: "MARKETING",
            components: [
              {
                type: "BODY",
                text: "Hi {{1}}, are you still interested in {{2}}?",
                example: { body_text: [["Alex", "Body assessment"]] },
              },
              {
                type: "BUTTONS",
                buttons: [{ type: "QUICK_REPLY", text: "Yes" }],
              },
            ],
          },
          {
            id: "2",
            name: "pending_template",
            language: "en_US",
            status: "PENDING",
            category: "UTILITY",
            components: [{ type: "BODY", text: "Pending" }],
          },
        ],
      });
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.templates.length, 1);
  assert.equal(result.templates[0].name, "lead_follow_up");
  assert.equal(result.templates[0].sendable, true);
  assert.deepEqual(result.templates[0].variableFields, [
    { component: "body", index: 1, label: "Body {{1}}", example: "Alex" },
    { component: "body", index: 2, label: "Body {{2}}", example: "Body assessment" },
  ]);
});

test("supports image and video headers while rejecting other unsupported template formats", () => {
  const media = templateService.normalizeTemplate({
    name: "photo_template",
    language: "en_US",
    status: "APPROVED",
    category: "MARKETING",
    components: [
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "Look at this" },
    ],
  });
  assert.equal(media.sendable, true);
  assert.equal(media.header.format, "IMAGE");
  assert.equal(media.unsupportedReason, null);

  const video = templateService.normalizeTemplate({
    name: "video_template",
    language: "en_US",
    status: "APPROVED",
    category: "MARKETING",
    components: [
      { type: "HEADER", format: "VIDEO" },
      { type: "BODY", text: "Video {{1}}" },
    ],
  });
  assert.equal(video.sendable, true);
  assert.equal(video.header.format, "VIDEO");

  const document = templateService.normalizeTemplate({
    name: "unsupported_document",
    language: "en_US",
    status: "APPROVED",
    category: "UTILITY",
    components: [
      { type: "HEADER", format: "DOCUMENT" },
      { type: "BODY", text: "Document" },
    ],
  });
  assert.equal(document.sendable, false);
  assert.match(document.unsupportedReason, /DOCUMENT/);

  const auth = templateService.normalizeTemplate({
    name: "otp",
    language: "en_US",
    status: "APPROVED",
    category: "AUTHENTICATION",
    components: [{ type: "BODY", text: "Your code is {{1}}" }],
  });
  assert.equal(auth.sendable, false);
  assert.match(auth.unsupportedReason, /Authentication/);

  const dynamicUrl = templateService.normalizeTemplate({
    name: "dynamic_url",
    language: "en_US",
    status: "APPROVED",
    category: "UTILITY",
    components: [
      { type: "BODY", text: "Open your booking" },
      {
        type: "BUTTONS",
        buttons: [{ type: "URL", text: "Open", url: "https://example.test/{{1}}" }],
      },
    ],
  });
  assert.equal(dynamicUrl.sendable, false);
  assert.match(dynamicUrl.unsupportedReason, /Dynamic URL/);

  const copyCode = templateService.normalizeTemplate({
    name: "copy_code",
    language: "en_US",
    status: "APPROVED",
    category: "MARKETING",
    components: [
      { type: "BODY", text: "Use this offer code." },
      {
        type: "BUTTONS",
        buttons: [{ type: "COPY_CODE", text: "Copy offer code" }],
      },
    ],
  });
  assert.equal(copyCode.sendable, false);
  assert.match(copyCode.unsupportedReason, /COPY_CODE/);
});

test("builds template send components and a staff preview from the same values", () => {
  const template = templateService.normalizeTemplate({
    name: "lead_follow_up",
    language: "en_US",
    status: "APPROVED",
    category: "MARKETING",
    components: [
      { type: "HEADER", format: "TEXT", text: "Follow-up for {{1}}" },
      { type: "BODY", text: "Hi {{1}}, are you still interested in {{2}}?" },
      { type: "FOOTER", text: "Reply STOP if you no longer want updates." },
    ],
  });

  const built = templateService.buildTemplateComponents(template, {
    header: ["Alex"],
    body: ["Alex", "Body assessment"],
  });

  assert.equal(built.valid, true);
  assert.deepEqual(built.components, [
    {
      type: "header",
      parameters: [{ type: "text", text: "Alex" }],
    },
    {
      type: "body",
      parameters: [
        { type: "text", text: "Alex" },
        { type: "text", text: "Body assessment" },
      ],
    },
  ]);
  assert.equal(
    templateService.renderTemplatePreview(template, built.values),
    "Follow-up for Alex\n\nHi Alex, are you still interested in Body assessment?\n\nReply STOP if you no longer want updates."
  );
});


test("image template requires server-uploaded Meta media ID and preserves body variables", () => {
  const template = templateService.normalizeTemplate({
    id: "tpl-media-image",
    name: "ns_fu_pricing_graphic",
    language: "zh_CN",
    status: "APPROVED",
    category: "MARKETING",
    components: [
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "Price for {{1}}" },
    ],
  });
  const missing = templateService.buildTemplateComponents(template, { body: ["Package A"] });
  assert.equal(missing.valid, false);
  assert.match(missing.error, /Choose an image/);

  const preflight = templateService.buildTemplateComponents(
    template, { body: ["Package A"] }, { allowMissingMedia: true }
  );
  assert.equal(preflight.valid, true);
  assert.deepEqual(preflight.components, [{ type: "body", parameters: [
    { type: "text", text: "Package A" },
  ] }]);

  for (const id of ["", "https://example.test/private.jpg", "123;delete"]) {
    const forged = templateService.buildTemplateComponents(template,
      { body: ["Package A"] }, { media: { id } });
    assert.equal(forged.valid, false);
  }

  const built = templateService.buildTemplateComponents(
    template, { body: ["Package A"] }, { media: { id: "123456789" } }
  );
  assert.equal(built.valid, true);
  assert.deepEqual(built.components[0], {
    type: "header",
    parameters: [{ type: "image", image: { id: "123456789" } }],
  });
  assert.deepEqual(built.components[1], { type: "body", parameters: [
    { type: "text", text: "Package A" },
  ] });
  assert.match(templateService.renderTemplatePreview(template, built.values), /Template image/);
});

test("video header can be attached, but text templates reject attachments", () => {
  const video = templateService.normalizeTemplate({
    id: "tpl-media-video",
    name: "ns_fu3_face_feedback",
    language: "en_US",
    status: "APPROVED",
    category: "MARKETING",
    components: [{ type: "HEADER", format: "VIDEO" }, { type: "BODY", text: "Feedback" }],
  });
  const built = templateService.buildTemplateComponents(video, {}, { media: { id: 9001 } });
  assert.equal(built.valid, true);
  assert.deepEqual(built.components, [{
    type: "header",
    parameters: [{ type: "video", video: { id: "9001" } }],
  }]);
  assert.match(templateService.renderTemplatePreview(video, {}), /Template video/);

  const textTemplate = templateService.normalizeTemplate({
    name: "text", language: "en_US", status: "APPROVED", category: "UTILITY",
    components: [{ type: "BODY", text: "hello" }],
  });
  assert.equal(templateService.buildTemplateComponents(textTemplate,
    {}, { media: { id: "111" } }).valid, false);
});

test("media header changes affect saved template signatures used for retry", () => {
  const make = (format) => templateService.normalizeTemplate({
    id: "t1", name: "offer", language: "en_US", status: "APPROVED",
    category: "MARKETING", components: [
      { type: "HEADER", format }, { type: "BODY", text: "offer" },
    ],
  });
  assert.notEqual(templateService.templateSignature(make("IMAGE")),
    templateService.templateSignature(make("VIDEO")));
});

test("rejects missing template variable values", () => {
  const template = templateService.normalizeTemplate({
    name: "lead_follow_up",
    language: "en_US",
    status: "APPROVED",
    category: "MARKETING",
    components: [{ type: "BODY", text: "Hi {{1}}, {{2}}" }],
  });

  const built = templateService.buildTemplateComponents(template, {
    body: ["Alex", ""],
  });
  assert.equal(built.valid, false);
  assert.match(built.error, /Fill in every body/);
});

test("template catalog requires both WABA id and runtime token", async () => {
  templateService.clearTemplateCache();
  const result = await templateService.listApprovedTemplates({
    env: { WHATSAPP_TOKEN: "token-only" },
    fetchImpl: async () => {
      throw new Error("must not fetch");
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.code, "template_catalog_not_configured");
});

test("sends the approved template payload through the WhatsApp Cloud API", async (t) => {
  const originalPolicy = whatsappPolicy.checkTemplateAllowed;
  const originalFetch = global.fetch;
  const oldPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const oldToken = process.env.WHATSAPP_TOKEN;

  t.after(() => {
    whatsappPolicy.checkTemplateAllowed = originalPolicy;
    global.fetch = originalFetch;
    if (oldPhoneId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = oldPhoneId;
    if (oldToken === undefined) delete process.env.WHATSAPP_TOKEN;
    else process.env.WHATSAPP_TOKEN = oldToken;
  });

  whatsappPolicy.checkTemplateAllowed = async () => ({ allowed: true });
  process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-1";
  process.env.WHATSAPP_TOKEN = "send-token";

  let sentBody = null;
  global.fetch = async (_url, options) => {
    sentBody = JSON.parse(options.body);
    return jsonResponse({ messages: [{ id: "wamid.template-1" }] });
  };

  const result = await templateService.sendApprovedTemplate(
    { id: 7, channel: "whatsapp", whatsapp_number: "60123456789" },
    {
      templateName: "lead_follow_up",
      languageCode: "en_US",
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: "Alex" }],
        },
      ],
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.wamid, "wamid.template-1");
  assert.equal(sentBody.type, "template");
  assert.equal(sentBody.template.name, "lead_follow_up");
  assert.equal(sentBody.template.language.code, "en_US");
  assert.equal(sentBody.template.components[0].parameters[0].text, "Alex");
});

test("builds Meta quick-reply button components for approved template buttons", () => {
  const template = templateService.normalizeTemplate({
    name: "lead_follow_up",
    language: "en_US",
    status: "APPROVED",
    category: "MARKETING",
    components: [
      { type: "BODY", text: "Are you still interested?" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Yes" },
          { type: "QUICK_REPLY", text: "Stop promotions" },
        ],
      },
    ],
  });

  const built = templateService.buildTemplateComponents(template, {});

  assert.equal(built.valid, true);
  assert.deepEqual(built.components, [
    {
      type: "button",
      sub_type: "quick_reply",
      index: "0",
      parameters: [
        {
          type: "payload",
          payload: "Yes",
        },
      ],
    },
    {
      type: "button",
      sub_type: "quick_reply",
      index: "1",
      parameters: [
        {
          type: "payload",
          payload: "Stop promotions",
        },
      ],
    },
  ]);
});

test("template transport blocks if the opt-in snapshot changed before send", async (t) => {
  const originalPolicy = whatsappPolicy.checkTemplateAllowed;
  const originalFetch = global.fetch;
  t.after(() => {
    whatsappPolicy.checkTemplateAllowed = originalPolicy;
    global.fetch = originalFetch;
  });

  whatsappPolicy.checkTemplateAllowed = async () => ({
    allowed: true,
    state: {
      whatsapp_opt_in_at: new Date("2026-09-29T10:30:00.000Z"),
    },
  });

  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("must not reach Meta");
  };

  const result = await templateService.sendApprovedTemplate(
    { id: 7, channel: "whatsapp", whatsapp_number: "60123456789" },
    {
      templateName: "lead_follow_up",
      languageCode: "en_US",
      expectedOptInAt: "2026-09-29T09:00:00.000Z",
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.policyBlocked, true);
  assert.equal(result.policyCode, "whatsapp_opt_in_changed");
  assert.match(result.error, /opt-in changed/i);
  assert.equal(fetchCalls, 0);
});

test("template signatures change when the approved template definition changes", () => {
  const original = templateService.normalizeTemplate({
    id: "tpl-1",
    name: "lead_follow_up",
    language: "en_US",
    status: "APPROVED",
    category: "UTILITY",
    components: [{ type: "BODY", text: "Hi {{1}}" }],
  });
  const changed = templateService.normalizeTemplate({
    id: "tpl-1",
    name: "lead_follow_up",
    language: "en_US",
    status: "APPROVED",
    category: "UTILITY",
    components: [{ type: "BODY", text: "Hello {{1}}, your appointment is ready." }],
  });

  assert.notEqual(
    templateService.templateSignature(original),
    templateService.templateSignature(changed)
  );
});

test("2xx template response without a WAMID is treated as unknown delivery", async (t) => {
  const originalPolicy = whatsappPolicy.checkTemplateAllowed;
  const oldPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const oldToken = process.env.WHATSAPP_TOKEN;
  t.after(() => {
    whatsappPolicy.checkTemplateAllowed = originalPolicy;
    if (oldPhoneId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = oldPhoneId;
    if (oldToken === undefined) delete process.env.WHATSAPP_TOKEN;
    else process.env.WHATSAPP_TOKEN = oldToken;
  });

  whatsappPolicy.checkTemplateAllowed = async () => ({ allowed: true, state: {} });
  process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-1";
  process.env.WHATSAPP_TOKEN = "token-1";

  const result = await templateService.sendApprovedTemplate(
    { id: 7, channel: "whatsapp", whatsapp_number: "60123456789" },
    {
      templateName: "lead_follow_up",
      languageCode: "en_US",
      fetchImpl: async () => jsonResponse({ messages: [{}] }),
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.unknown, true);
  assert.equal(result.wamid, null);
  assert.match(result.error, /did not return a message ID/i);
});

test("template send timeout is treated as unknown because provider acceptance is ambiguous", async (t) => {
  const originalPolicy = whatsappPolicy.checkTemplateAllowed;
  const oldPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const oldToken = process.env.WHATSAPP_TOKEN;
  t.after(() => {
    whatsappPolicy.checkTemplateAllowed = originalPolicy;
    if (oldPhoneId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = oldPhoneId;
    if (oldToken === undefined) delete process.env.WHATSAPP_TOKEN;
    else process.env.WHATSAPP_TOKEN = oldToken;
  });

  whatsappPolicy.checkTemplateAllowed = async () => ({ allowed: true, state: {} });
  process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-1";
  process.env.WHATSAPP_TOKEN = "token-1";

  const fetchImpl = async (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      }, { once: true });
    });

  const result = await templateService.sendApprovedTemplate(
    { id: 7, channel: "whatsapp", whatsapp_number: "60123456789" },
    {
      templateName: "lead_follow_up",
      languageCode: "en_US",
      fetchImpl,
      timeoutMs: 5,
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.unknown, true);
  assert.match(result.error, /timed out/i);
});

test("template catalog request times out instead of hanging the Inbox", async () => {
  templateService.clearTemplateCache();
  const fetchImpl = async (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      }, { once: true });
    });

  const result = await templateService.listApprovedTemplates({
    env: {
      WHATSAPP_WABA_ID: "waba-timeout",
      WHATSAPP_TOKEN: "token-timeout",
    },
    fetchImpl,
    timeoutMs: 5,
    force: true,
  });

  assert.equal(result.success, false);
  assert.equal(result.code, "template_catalog_timeout");
  assert.match(result.error, /timed out/i);
});

test("template transport passes the template category into the final policy check", async (t) => {
  const originalPolicy = whatsappPolicy.checkTemplateAllowed;
  const oldPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const oldToken = process.env.WHATSAPP_TOKEN;
  t.after(() => {
    whatsappPolicy.checkTemplateAllowed = originalPolicy;
    if (oldPhoneId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = oldPhoneId;
    if (oldToken === undefined) delete process.env.WHATSAPP_TOKEN;
    else process.env.WHATSAPP_TOKEN = oldToken;
  });

  let receivedOptions = null;
  whatsappPolicy.checkTemplateAllowed = async (_contact, options) => {
    receivedOptions = options;
    return {
      allowed: false,
      code: "marketing_opted_out",
      message: "blocked",
    };
  };
  process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-1";
  process.env.WHATSAPP_TOKEN = "token-1";

  const result = await templateService.sendApprovedTemplate(
    { id: 7, channel: "whatsapp", whatsapp_number: "60123456789" },
    {
      templateName: "promo_follow_up",
      languageCode: "en_US",
      templateCategory: "MARKETING",
      fetchImpl: async () => assert.fail("provider must not be called"),
    }
  );

  assert.deepEqual(receivedOptions, { category: "MARKETING" });
  assert.equal(result.success, false);
  assert.equal(result.policyCode, "marketing_opted_out");
});

