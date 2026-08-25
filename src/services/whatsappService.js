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
 * Downloads a media attachment (e.g. a voice note) from the WhatsApp Cloud API.
 * This is a two-step process: first resolve the media ID to a short-lived
 * URL, then fetch the bytes from that URL — both requests need the same
 * bearer token, but the second one is what actually returns the audio.
 * @param {string} mediaId
 * @returns {Promise<{buffer: Buffer, mimeType: string}|null>} null on any failure
 */
async function downloadMedia(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;

  try {
    const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!metaRes.ok) {
      console.error("WhatsApp media lookup failed:", metaRes.status, await metaRes.text());
      return null;
    }
    const meta = await metaRes.json();

    const fileRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!fileRes.ok) {
      console.error("WhatsApp media download failed:", fileRes.status);
      return null;
    }

    const arrayBuffer = await fileRes.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), mimeType: meta.mime_type || "audio/ogg" };
  } catch (err) {
    console.error("WhatsApp media download threw an error:", err);
    return null;
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
      if (message.type === "text") {
        return {
          id: message.id, // used for de-duplicating retried webhooks
          from: message.from, // patient's WhatsApp number, used as the conversation key
          text: message.text.body,
          mediaId: null,
          mediaType: null,
          unsupportedType: null,
        };
      }
      if (message.type === "audio") {
        return {
          id: message.id,
          from: message.from,
          text: null,
          mediaId: message.audio.id, // resolved via downloadMedia() in server.js
          mediaType: "audio",
          unsupportedType: null,
        };
      }
      if (message.type === "image") {
        return {
          id: message.id,
          from: message.from,
          text: message.image.caption || null, // patients often send a photo with no caption
          mediaId: message.image.id, // resolved via downloadMedia() in server.js
          mediaType: "image",
          unsupportedType: null,
        };
      }
      return { id: message.id, from: message.from, text: null, mediaId: null, mediaType: null, unsupportedType: message.type };
    });
  } catch (err) {
    console.error("Failed to parse webhook payload:", err);
    return [];
  }
}

module.exports = { sendMessage, sendImage, downloadMedia, parseIncomingMessages };
