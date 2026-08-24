const GRAPH_API_VERSION = "v20.0";

/**
 * Sends a plain text WhatsApp message via the Cloud API.
 * @param {string} to - recipient's WhatsApp ID (phone number, no '+')
 * @param {string} text
 * @returns {Promise<boolean>} true if sent successfully, false otherwise (never throws —
 *   callers, e.g. the AI auto-reply flow, already have their own fallback logic around this)
 */
async function sendMessage(to, text) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error("WhatsApp send failed:", res.status, errBody);
      return false;
    }
    return true;
  } catch (err) {
    console.error("WhatsApp send threw an error:", err);
    return false;
  }
}

/**
 * Sends an image message (by public URL) via the Cloud API, with an optional caption.
 * @param {string} to - recipient's WhatsApp ID (phone number, no '+')
 * @param {string} imageUrl - publicly accessible URL of the image
 * @param {string} [caption] - optional text shown under the image
 * @returns {Promise<boolean>} true if sent successfully, false otherwise (never throws —
 *   a failed promo image should never take down the actual text reply around it)
 */
async function sendImage(to, imageUrl, caption) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: caption ? { link: imageUrl, caption } : { link: imageUrl },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error("WhatsApp image send failed:", res.status, errBody);
      return false;
    }
    return true;
  } catch (err) {
    console.error("WhatsApp image send threw an error:", err);
    return false;
  }
}

/**
 * Pulls out every inbound message from a WhatsApp webhook payload.
 * Returns an array (usually 0 or 1 entries, but Meta can batch several
 * if a patient sends multiple texts in quick succession).
 * Skips anything that isn't a genuine new message (e.g. delivery/read status updates).
 */
function parseIncomingMessages(body) {
  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return []; // status update, not a new message

    return messages.map((message) => {
      if (message.type !== "text") {
        return { id: message.id, from: message.from, text: null, unsupportedType: message.type };
      }
      return {
        id: message.id, // used for de-duplicating retried webhooks
        from: message.from, // patient's WhatsApp number, used as the conversation key
        text: message.text.body,
        unsupportedType: null,
      };
    });
  } catch (err) {
    console.error("Failed to parse webhook payload:", err);
    return [];
  }
}

module.exports = { sendMessage, sendImage, parseIncomingMessages };
