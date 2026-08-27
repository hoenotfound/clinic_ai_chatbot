const GRAPH_API_VERSION = "v26.0";

// A 200 OK from POST .../messages only means Meta *accepted* the send
// request for later processing — it is not proof the patient's phone ever
// received it. Actual delivery/failure is reported asynchronously via a
// separate status-update webhook (see parseStatusUpdates below), which is
// why every send function here also returns the WAMID: it's the only key
// that lets that later callback be matched back to this specific message.
function extractWamid(data) {
  return data?.messages?.[0]?.id || null;
}

/**
 * Sends a plain text WhatsApp message via the Cloud API.
 * @param {string} to - recipient's WhatsApp ID (phone number, no '+')
 * @param {string} text
 * @returns {Promise<{success: boolean, wamid: string|null}>} success is true if Meta
 *   *accepted* the send request — NOT proof of actual delivery (see note above).
 *   Never throws — callers, e.g. the AI auto-reply flow, already have their own
 *   fallback logic around this.
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
      return { success: false, wamid: null };
    }
    const data = await res.json();
    return { success: true, wamid: extractWamid(data) };
  } catch (err) {
    console.error("WhatsApp send threw an error:", err);
    return { success: false, wamid: null };
  }
}

/**
 * Sends an image message (by public URL) via the Cloud API, with an optional caption.
 * @param {string} to - recipient's WhatsApp ID (phone number, no '+')
 * @param {string} imageUrl - publicly accessible URL of the image
 * @param {string} [caption] - optional text shown under the image
 * @returns {Promise<{success: boolean, wamid: string|null}>} success is true if Meta
 *   accepted the send request (never throws — a failed promo image should never
 *   take down the actual text reply around it)
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
      return { success: false, wamid: null };
    }
    const data = await res.json();
    return { success: true, wamid: extractWamid(data) };
  } catch (err) {
    console.error("WhatsApp image send threw an error:", err);
    return { success: false, wamid: null };
  }
}

/**
 * Uploads local media bytes to the WhatsApp Cloud API media endpoint and
 * returns the media ID used by sendImageById() or sendVoiceById().
 * @param {Buffer} buffer - raw file bytes
 * @param {string} mimeType - e.g. "image/jpeg", "image/png", "audio/ogg"
 * @param {string} [filename] - filename supplied to Meta
 * @returns {Promise<string|null>} the WhatsApp media ID, or null on failure
 */
async function uploadMedia(buffer, mimeType, filename = "upload") {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/media`;

  try {
    // Match the multipart shape verified to work for WhatsApp voice notes:
    // messaging_product + one file part whose own Content-Type is audio/ogg.
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", new Blob([buffer], { type: mimeType }), filename);

    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error("WhatsApp media upload failed:", res.status, errBody);
      return null;
    }

    const data = await res.json();
    return data.id || null;
  } catch (err) {
    console.error("WhatsApp media upload threw an error:", err);
    return null;
  }
}

/**
 * Sends an image message by a WhatsApp media ID (from uploadMedia()) rather
 * than a public URL — used for one-off images staff upload from the Inbox,
 * as opposed to sendImage()'s link-based approach for pre-hosted graphics.
 * @param {string} to - recipient's WhatsApp ID (phone number, no '+')
 * @param {string} mediaId
 * @param {string} [caption]
 * @returns {Promise<{success: boolean, wamid: string|null}>} success is true if
 *   Meta accepted the send request
 */
async function sendImageById(to, mediaId, caption) {
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
        image: caption ? { id: mediaId, caption } : { id: mediaId },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error("WhatsApp image (by id) send failed:", res.status, errBody);
      return { success: false, wamid: null };
    }
    const data = await res.json();
    return { success: true, wamid: extractWamid(data) };
  } catch (err) {
    console.error("WhatsApp image (by id) send threw an error:", err);
    return { success: false, wamid: null };
  }
}

/**
 * Sends an uploaded Ogg/Opus file as a native WhatsApp voice note. The
 * `voice: true` flag is what makes WhatsApp render the recording as a voice
 * message rather than a generic audio attachment.
 * @param {string} to - recipient's WhatsApp ID (phone number, no '+')
 * @param {string} mediaId - ID returned by uploadMedia()
 * @returns {Promise<{success: boolean, wamid: string|null}>} success is true if Meta
 *   *accepted* the message — this is NOT proof of actual delivery. The real
 *   outcome arrives later via the status-update webhook, matched by wamid.
 */
async function sendVoiceById(to, mediaId) {
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
        type: "audio",
        audio: { id: mediaId, voice: true },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error("WhatsApp voice send failed:", res.status, errBody);
      return { success: false, wamid: null };
    }
    const data = await res.json();
    return { success: true, wamid: extractWamid(data) };
  } catch (err) {
    console.error("WhatsApp voice send threw an error:", err);
    return { success: false, wamid: null };
  }
}

/**
 * Downloads a media attachment from the WhatsApp Cloud API.
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
 */
function parseIncomingMessages(body) {
  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;
    const contacts = value?.contacts || [];

    if (!messages || messages.length === 0) return [];

    return messages.map((message) => {
      const whatsappContact = contacts.find((contact) => contact.wa_id === message.from);
      const profileName = whatsappContact?.profile?.name?.trim() || null;

      if (message.type === "text") {
        return {
          id: message.id,
          from: message.from,
          profileName,
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
          profileName,
          text: null,
          mediaId: message.audio.id,
          mediaType: "audio",
          unsupportedType: null,
        };
      }
      if (message.type === "image") {
        return {
          id: message.id,
          from: message.from,
          profileName,
          text: message.image.caption || null,
          mediaId: message.image.id,
          mediaType: "image",
          unsupportedType: null,
        };
      }
      return {
        id: message.id,
        from: message.from,
        profileName,
        text: null,
        mediaId: null,
        mediaType: null,
        unsupportedType: message.type,
      };
    });
  } catch (err) {
    console.error("Failed to parse webhook payload:", err);
    return [];
  }
}

/**
 * Pulls out delivery-status updates for outbound WhatsApp messages.
 * @returns {Array<{wamid: string, status: string, errorCode: number|null,
 *   errorTitle: string|null, errorMessage: string|null}>}
 */
function parseStatusUpdates(body) {
  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const statuses = change?.value?.statuses;
    if (!statuses || statuses.length === 0) return [];

    return statuses.map((status) => {
      const firstError = status.errors?.[0] || null;
      return {
        wamid: status.id,
        status: status.status,
        errorCode: firstError?.code ?? null,
        errorTitle: firstError?.title || null,
        errorMessage: firstError?.error_data?.details || firstError?.message || null,
      };
    });
  } catch (err) {
    console.error("Failed to parse webhook status payload:", err);
    return [];
  }
}

module.exports = {
  sendMessage,
  sendImage,
  uploadMedia,
  sendImageById,
  sendVoiceById,
  downloadMedia,
  parseIncomingMessages,
  parseStatusUpdates,
};
