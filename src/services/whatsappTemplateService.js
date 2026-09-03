const whatsappPolicy = require("./whatsappPolicyService");

const GRAPH_API_VERSION = "v26.0";

function extractWamid(data) {
  return data?.messages?.[0]?.id || null;
}

async function sendApprovedTemplate(
  contact,
  {
    templateName,
    languageCode = "en_US",
    components = undefined,
  } = {}
) {
  const name = String(templateName || "").trim();
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
    policy = await whatsappPolicy.checkTemplateAllowed(contact);
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

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
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
    language: { code: String(languageCode || "en_US") },
  };
  if (Array.isArray(components) && components.length) {
    template.components = components;
  }

  try {
    const res = await fetch(
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
      }
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

    const data = await res.json();
    return {
      success: true,
      wamid: extractWamid(data),
      policyBlocked: false,
      error: null,
    };
  } catch (err) {
    console.error("WhatsApp template send threw an error:", err);
    return {
      success: false,
      wamid: null,
      policyBlocked: false,
      error: "WhatsApp template delivery could not be started.",
    };
  }
}

module.exports = { sendApprovedTemplate };
