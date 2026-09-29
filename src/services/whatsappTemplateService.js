const crypto = require("crypto");
const whatsappPolicy = require("./whatsappPolicyService");

const GRAPH_API_VERSION = "v26.0";
const TEMPLATE_CACHE_TTL_MS = 60 * 1000;
const MAX_TEMPLATE_PAGES = 10;
const DEFAULT_META_REQUEST_TIMEOUT_MS = 10 * 1000;
let templateCache = null;

function clean(value) {
  return String(value || "").trim();
}

function extractWamid(data) {
  return data?.messages?.[0]?.id || null;
}

function templateConfig(env = process.env) {
  return {
    wabaId: clean(env.WHATSAPP_WABA_ID),
    phoneNumberId: clean(env.WHATSAPP_PHONE_NUMBER_ID),
    token: clean(env.WHATSAPP_TOKEN),
  };
}

function numberedVariables(text) {
  const value = String(text || "");
  const indexes = [...value.matchAll(/\{\{\s*(\d+)\s*\}\}/g)]
    .map((match) => Number(match[1]))
    .filter((index) => Number.isSafeInteger(index) && index > 0);
  return [...new Set(indexes)].sort((a, b) => a - b);
}

function hasNamedVariables(text) {
  const matches = [...String(text || "").matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)];
  return matches.some((match) => !/^\d+$/.test(match[1]));
}

function variablesAreSequential(indexes) {
  return indexes.every((index, position) => index === position + 1);
}

function firstExample(component, key, index) {
  const value = component?.example?.[key];
  if (!Array.isArray(value)) return null;
  const flattened = Array.isArray(value[0]) ? value[0] : value;
  const example = flattened[index - 1];
  return example == null ? null : String(example);
}

function normalizeButtons(component) {
  const buttons = Array.isArray(component?.buttons) ? component.buttons : [];
  return buttons.map((button, index) => ({
    index,
    type: clean(button?.type).toUpperCase(),
    text: clean(button?.text),
    url: clean(button?.url) || null,
  }));
}

function normalizeTemplate(raw) {
  const components = Array.isArray(raw?.components) ? raw.components : [];
  const header = components.find((item) => clean(item?.type).toUpperCase() === "HEADER") || null;
  const body = components.find((item) => clean(item?.type).toUpperCase() === "BODY") || null;
  const footer = components.find((item) => clean(item?.type).toUpperCase() === "FOOTER") || null;
  const buttonsComponent =
    components.find((item) => clean(item?.type).toUpperCase() === "BUTTONS") || null;

  const headerFormat = clean(header?.format || "TEXT").toUpperCase();
  const headerText = clean(header?.text);
  const bodyText = clean(body?.text);
  const footerText = clean(footer?.text);
  const headerVariables = numberedVariables(headerText);
  const bodyVariables = numberedVariables(bodyText);
  const buttons = normalizeButtons(buttonsComponent);
  const unsupportedReasons = [];

  if (header && headerFormat !== "TEXT") {
    unsupportedReasons.push("Media-header templates are not supported from Inbox yet.");
  }
  if (hasNamedVariables(headerText) || hasNamedVariables(bodyText)) {
    unsupportedReasons.push("Named template variables are not supported from Inbox yet.");
  }
  if (!variablesAreSequential(headerVariables) || !variablesAreSequential(bodyVariables)) {
    unsupportedReasons.push("Template variables must use sequential {{1}}, {{2}} placeholders.");
  }
  if (clean(raw?.category).toUpperCase() === "AUTHENTICATION") {
    unsupportedReasons.push("Authentication templates are not supported from Inbox.");
  }
  if (buttons.some((button) => /\{\{[^}]+\}\}/.test(button.url || ""))) {
    unsupportedReasons.push("Dynamic URL button variables are not supported from Inbox yet.");
  }
  const supportedStaticButtonTypes = new Set([
    "QUICK_REPLY",
    "URL",
    "PHONE_NUMBER",
  ]);
  const unsupportedButton = buttons.find(
    (button) => button.type && !supportedStaticButtonTypes.has(button.type)
  );
  if (unsupportedButton) {
    unsupportedReasons.push(
      `${unsupportedButton.type} template buttons are not supported from Inbox yet.`
    );
  }

  const variableFields = [
    ...headerVariables.map((index) => ({
      component: "header",
      index,
      label: `Header {{${index}}}`,
      example: firstExample(header, "header_text", index),
    })),
    ...bodyVariables.map((index) => ({
      component: "body",
      index,
      label: `Body {{${index}}}`,
      example: firstExample(body, "body_text", index),
    })),
  ];

  return {
    id: raw?.id == null ? null : String(raw.id),
    name: clean(raw?.name),
    language: clean(raw?.language),
    status: clean(raw?.status).toUpperCase(),
    category: clean(raw?.category).toUpperCase() || "UNKNOWN",
    header: header
      ? {
          format: headerFormat,
          text: headerText,
        }
      : null,
    body: bodyText ? { text: bodyText } : null,
    footer: footerText ? { text: footerText } : null,
    buttons,
    variableFields,
    sendable: unsupportedReasons.length === 0,
    unsupportedReason: unsupportedReasons[0] || null,
  };
}

function normalizeValues(values) {
  return {
    header: Array.isArray(values?.header) ? values.header.map((value) => clean(value)) : [],
    body: Array.isArray(values?.body) ? values.body.map((value) => clean(value)) : [],
  };
}

function requiredCount(template, component) {
  return (template?.variableFields || []).filter((field) => field.component === component).length;
}

function validateTemplateValues(template, values) {
  if (!template?.sendable) {
    return {
      valid: false,
      error: template?.unsupportedReason || "This template cannot be sent from Inbox.",
    };
  }

  const normalized = normalizeValues(values);
  for (const component of ["header", "body"]) {
    const expected = requiredCount(template, component);
    if (normalized[component].length !== expected) {
      return {
        valid: false,
        error: `This template needs ${expected} ${component} variable${expected === 1 ? "" : "s"}.`,
      };
    }
    if (normalized[component].some((value) => !value)) {
      return {
        valid: false,
        error: `Fill in every ${component} template variable before sending.`,
      };
    }
    if (normalized[component].some((value) => value.length > 1024)) {
      return {
        valid: false,
        error: "Template variable values must be 1024 characters or fewer.",
      };
    }
  }

  return { valid: true, values: normalized, error: null };
}

function quickReplyPayload(template, button) {
  const label = clean(button?.text);
  if (label) return label.slice(0, 200);
  const templateKey = clean(template?.name).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "template";
  return `da_qr:${templateKey}:${button.index}`;
}

function templateSignature(template) {
  const stable = {
    id: template?.id || null,
    name: template?.name || "",
    language: template?.language || "",
    category: template?.category || "",
    header: template?.header || null,
    body: template?.body || null,
    footer: template?.footer || null,
    buttons: template?.buttons || [],
    variableFields: template?.variableFields || [],
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = DEFAULT_META_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildTemplateComponents(template, values) {
  const validation = validateTemplateValues(template, values);
  if (!validation.valid) return validation;

  const components = [];
  for (const component of ["header", "body"]) {
    const parameters = validation.values[component].map((value) => ({
      type: "text",
      text: value,
    }));
    if (parameters.length) {
      components.push({ type: component, parameters });
    }
  }

  for (const button of template?.buttons || []) {
    if (button.type !== "QUICK_REPLY") continue;
    components.push({
      type: "button",
      sub_type: "quick_reply",
      index: String(button.index),
      parameters: [
        {
          type: "payload",
          payload: quickReplyPayload(template, button),
        },
      ],
    });
  }

  return {
    valid: true,
    components,
    values: validation.values,
    error: null,
  };
}

function replaceVariables(text, values) {
  return String(text || "").replace(/\{\{\s*(\d+)\s*\}\}/g, (_match, rawIndex) => {
    const value = values[Number(rawIndex) - 1];
    return value == null || value === "" ? `{{${rawIndex}}}` : value;
  });
}

function renderTemplatePreview(template, values = {}) {
  const normalized = normalizeValues(values);
  const parts = [];
  if (template?.header?.text) {
    parts.push(replaceVariables(template.header.text, normalized.header));
  }
  if (template?.body?.text) {
    parts.push(replaceVariables(template.body.text, normalized.body));
  }
  if (template?.footer?.text) parts.push(template.footer.text);
  return parts.filter(Boolean).join("\n\n").trim();
}

function policyTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clearTemplateCache() {
  templateCache = null;
}

async function listApprovedTemplates({
  env = process.env,
  fetchImpl = global.fetch,
  force = false,
  timeoutMs = DEFAULT_META_REQUEST_TIMEOUT_MS,
} = {}) {
  const { wabaId, token } = templateConfig(env);
  if (!wabaId || !token) {
    return {
      success: false,
      templates: [],
      error:
        "WhatsApp template catalog is not configured. WHATSAPP_WABA_ID and WHATSAPP_TOKEN are required.",
      code: "template_catalog_not_configured",
    };
  }
  if (typeof fetchImpl !== "function") {
    return {
      success: false,
      templates: [],
      error: "WhatsApp template catalog cannot be loaded because fetch is unavailable.",
      code: "template_catalog_unavailable",
    };
  }

  const now = Date.now();
  if (
    !force &&
    templateCache?.wabaId === wabaId &&
    now - templateCache.loadedAt < TEMPLATE_CACHE_TTL_MS
  ) {
    return {
      success: true,
      templates: templateCache.templates,
      error: null,
      code: null,
      cached: true,
    };
  }

  const rawTemplates = [];
  let after = null;

  try {
    for (let page = 0; page < MAX_TEMPLATE_PAGES; page += 1) {
      const url = new URL(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(wabaId)}/message_templates`
      );
      url.searchParams.set("fields", "id,name,language,status,category,components");
      url.searchParams.set("limit", "100");
      if (after) url.searchParams.set("after", after);

      const response = await fetchWithTimeout(
        fetchImpl,
        url.toString(),
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        },
        timeoutMs
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.error(
          "WhatsApp template catalog fetch failed:",
          response.status,
          data?.error?.message || data
        );
        return {
          success: false,
          templates: [],
          error:
            "Could not load approved WhatsApp templates from Meta. Confirm the WABA ID and that the runtime token can read WhatsApp message templates.",
          code: "template_catalog_fetch_failed",
        };
      }

      rawTemplates.push(...(Array.isArray(data?.data) ? data.data : []));
      after = clean(data?.paging?.cursors?.after);
      if (!after || !data?.paging?.next) break;
    }
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    console.error("WhatsApp template catalog request failed:", err);
    return {
      success: false,
      templates: [],
      error: timedOut
        ? "Loading approved WhatsApp templates from Meta timed out. Please try again."
        : "Could not reach Meta to load approved WhatsApp templates.",
      code: timedOut ? "template_catalog_timeout" : "template_catalog_unavailable",
    };
  }

  const templates = rawTemplates
    .map(normalizeTemplate)
    .filter((template) => template.status === "APPROVED" && template.name && template.language)
    .sort((a, b) =>
      a.name.localeCompare(b.name) || a.language.localeCompare(b.language)
    );

  templateCache = { wabaId, loadedAt: now, templates };
  return {
    success: true,
    templates,
    error: null,
    code: null,
    cached: false,
  };
}

async function resolveApprovedTemplate(
  templateName,
  languageCode,
  options = {}
) {
  const name = clean(templateName);
  const language = clean(languageCode);
  const catalog = await listApprovedTemplates(options);
  if (!catalog.success) return { ...catalog, template: null };

  const template =
    catalog.templates.find(
      (item) => item.name === name && item.language === language
    ) || null;

  if (!template) {
    return {
      success: false,
      template: null,
      templates: catalog.templates,
      error: "That WhatsApp template is no longer approved or available for this language.",
      code: "template_not_available",
    };
  }

  return {
    success: true,
    template,
    templates: catalog.templates,
    error: null,
    code: null,
  };
}

async function sendApprovedTemplate(
  contact,
  {
    templateName,
    languageCode = "en_US",
    components = undefined,
    expectedOptInAt = null,
    templateCategory = null,
    fetchImpl = global.fetch,
    timeoutMs = DEFAULT_META_REQUEST_TIMEOUT_MS,
  } = {}
) {
  const name = clean(templateName);
  if (!name) {
    return {
      success: false,
      wamid: null,
      policyBlocked: false,
      error: "An approved WhatsApp template name is required.",
    };
  }

  let policy;
  try {
    policy = await whatsappPolicy.checkTemplateAllowed(contact, {
      category: templateCategory,
    });
  } catch (err) {
    console.error("Failed to verify WhatsApp template policy state:", err);
    return whatsappPolicy.blockedSendResult({
      code: "policy_state_unavailable",
      message:
        "WhatsApp template blocked because messaging-policy state could not be verified. Please retry after the connection recovers.",
    });
  }
  if (!policy.allowed) {
    return whatsappPolicy.blockedSendResult(policy);
  }

  if (expectedOptInAt) {
    const expected = policyTimestamp(expectedOptInAt);
    const current = policyTimestamp(policy.state?.whatsapp_opt_in_at);
    if (!expected || !current || expected !== current) {
      return whatsappPolicy.blockedSendResult({
        code: "whatsapp_opt_in_changed",
        message:
          "WhatsApp template blocked because the customer's recorded opt-in changed. Reconfirm consent and send the template again from the template picker.",
      });
    }
  }

  const { phoneNumberId, token } = templateConfig(process.env);
  if (!phoneNumberId || !token) {
    return {
      success: false,
      wamid: null,
      policyBlocked: false,
      error: "WhatsApp Cloud API is not configured.",
    };
  }

  const template = {
    name,
    language: { code: clean(languageCode) || "en_US" },
  };
  if (Array.isArray(components) && components.length) {
    template.components = components;
  }

  let providerAccepted = false;
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: contact.whatsapp_number,
          type: "template",
          template,
        }),
      },
      timeoutMs
    );

    if (!res.ok) {
      const errBody = await res.text();
      console.error("WhatsApp template send failed:", res.status, errBody);
      return {
        success: false,
        wamid: null,
        policyBlocked: false,
        error: "WhatsApp did not accept this approved template.",
      };
    }

    providerAccepted = true;
    const data = await res.json();
    const wamid = extractWamid(data);
    if (!wamid) {
      return {
        success: false,
        unknown: true,
        wamid: null,
        policyBlocked: false,
        error:
          "WhatsApp accepted the template request but did not return a message ID, so delivery could not be confirmed. Check WhatsApp before retrying.",
      };
    }
    return {
      success: true,
      unknown: false,
      wamid,
      policyBlocked: false,
      error: null,
    };
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    console.error("WhatsApp template send threw an error:", err);
    return {
      success: false,
      unknown: timedOut || providerAccepted,
      wamid: null,
      policyBlocked: false,
      error: timedOut
        ? "WhatsApp template send timed out, so delivery could not be confirmed. Check WhatsApp before retrying."
        : providerAccepted
          ? "WhatsApp accepted the template request, but its response could not be verified. Check WhatsApp before retrying."
          : "WhatsApp template delivery could not be started.",
    };
  }
}

module.exports = {
  DEFAULT_META_REQUEST_TIMEOUT_MS,
  GRAPH_API_VERSION,
  buildTemplateComponents,
  clearTemplateCache,
  listApprovedTemplates,
  normalizeTemplate,
  policyTimestamp,
  quickReplyPayload,
  renderTemplatePreview,
  templateSignature,
  resolveApprovedTemplate,
  sendApprovedTemplate,
  templateConfig,
  validateTemplateValues,
};
