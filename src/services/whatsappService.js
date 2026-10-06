const GRAPH_API_VERSION = "v26.0";
const DEFAULT_META_MESSAGE_REQUEST_TIMEOUT_MS = 10 * 1000;
const DEFAULT_META_MEDIA_UPLOAD_TIMEOUT_MS = 15 * 1000;
const { normalizeWhatsAppReferral } = require("../utils/leadAttribution");

const TRANSIENT_SEND_HTTP_STATUSES = new Set([429]);
const TRANSIENT_SEND_ERROR_CODES = new Set([131000, 131016]);

function requestTimeoutMs(rawValue, fallback) {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = DEFAULT_META_MESSAGE_REQUEST_TIMEOUT_MS
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function interruptedDeliveryResult(err) {
  const timedOut = err?.name === "AbortError";
  return {
    success: false,
    wamid: null,
    error: timedOut
      ? "WhatsApp delivery could not be confirmed because the provider request timed out."
      : "WhatsApp delivery could not be confirmed because the provider request was interrupted.",
    retryable: false,
    ambiguous: true,
    unknown: true,
    networkErrorCode: err?.code ? String(err.code) : null,
  };
}

function parseWhatsappApiError(rawBody) {
  try {
    const parsed = JSON.parse(String(rawBody || ""));
    return parsed?.error && typeof parsed.error === "object" ? parsed.error : null;
  } catch {
    return null;
  }
}

function classifyWhatsappSendFailure(httpStatus, rawBody) {
  const providerError = parseWhatsappApiError(rawBody);
  const providerErrorCode = Number(providerError?.code);
  const normalizedCode = Number.isInteger(providerErrorCode)
    ? providerErrorCode
    : null;
  const normalizedStatus = Number(httpStatus);
  const retryable =
    TRANSIENT_SEND_HTTP_STATUSES.has(normalizedStatus) ||
    (normalizedCode !== null && TRANSIENT_SEND_ERROR_CODES.has(normalizedCode));
  const error = String(
    providerError?.error_data?.details ||
      providerError?.message ||
      `WhatsApp rejected the send with HTTP ${httpStatus}.`
  ).trim();

  return {
    success: false,
    wamid: null,
    error,
    retryable,
    ambiguous: false,
    providerStatus: Number(httpStatus) || null,
    providerErrorCode: normalizedCode,
  };
}

function classifyWhatsappAcceptedResponse(data) {
  const wamid = extractWamid(data);
  if (wamid) {
    return {
      success: true,
      wamid,
      retryable: false,
      ambiguous: false,
    };
  }

  return {
    success: false,
    wamid: null,
    error:
      "WhatsApp accepted the HTTP request but did not return a message ID, so delivery cannot be confirmed.",
    retryable: false,
    ambiguous: true,
    unknown: true,
  };
}

// A 200 OK from POST .../messages only means Meta *accepted* the send
// request for later processing — it is not proof the patient's phone ever
// received it. Actual delivery/failure is reported asynchronously via a
// separate status-update webhook (see parseStatusUpdates below), which is
// why every send function here also returns the WAMID: it's the only key
// that lets that later callback be matched back to this specific message.
function extractWamid(data) {
  return data?.messages?.[0]?.id || null;
}

function replyContext(options = {}) {
  const messageId = String(options?.replyToProviderMessageId || "").trim();
  return messageId ? { context: { message_id: messageId } } : {};
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
async function sendMessage(to, text, options = {}) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  try {
    const res = await fetchWithTimeout(
      url,
      {
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
          ...replyContext(options),
        }),
      },
      requestTimeoutMs(
        process.env.WHATSAPP_MESSAGE_TIMEOUT_MS,
        DEFAULT_META_MESSAGE_REQUEST_TIMEOUT_MS
      )
    );

    if (!res.ok) {
      const errBody = await res.text();
      console.error("WhatsApp send failed:", res.status, errBody);
      return classifyWhatsappSendFailure(res.status, errBody);
    }
    const data = await res.json();
    return classifyWhatsappAcceptedResponse(data);
  } catch (err) {
    console.error("WhatsApp send threw an error:", err);
    return interruptedDeliveryResult(err);
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
async function sendImage(to, imageUrl, caption, options = {}) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  try {
    const res = await fetchWithTimeout(
      url,
      {
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
          ...replyContext(options),
        }),
      },
      requestTimeoutMs(
        process.env.WHATSAPP_MESSAGE_TIMEOUT_MS,
        DEFAULT_META_MESSAGE_REQUEST_TIMEOUT_MS
      )
    );

    if (!res.ok) {
      const errBody = await res.text();
      console.error("WhatsApp image send failed:", res.status, errBody);
      return classifyWhatsappSendFailure(res.status, errBody);
    }
    const data = await res.json();
    return classifyWhatsappAcceptedResponse(data);
  } catch (err) {
    console.error("WhatsApp image send threw an error:", err);
    return interruptedDeliveryResult(err);
  }
}

/**
 * Uploads a local file (e.g. an image a staff member picked from their
 * computer) to the WhatsApp Cloud API's media endpoint, returning a media ID
 * that can be passed to sendImageById(). This is the counterpart to
 * sendImage() above: sendImage() needs a *publicly hosted* URL (fine for the
 * promo graphic, which lives on our own server/CDN), but staff-uploaded
 * images only exist as bytes in memory — uploading them to WhatsApp first
 * avoids having to stand up public hosting just to send one photo.
 * @param {Buffer} buffer - raw file bytes
 * @param {string} mimeType - e.g. "image/jpeg", "image/png", "audio/ogg"
 * @param {string} [filename] - filename supplied to Meta (important for voice.ogg)
 * @returns {Promise<string|null>} the WhatsApp media ID, or null on failure
 */
async function uploadMedia(buffer, mimeType, filename = "upload") {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/media`;

  try {
    // Keep this multipart shape aligned with the raw curl request that was
    // independently proven to deliver a WhatsApp voice note successfully:
    // messaging_product + one file part whose own Content-Type is audio/ogg.
    // Do not add a separate `type` form field.
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", new Blob([buffer], { type: mimeType }), filename);

    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      },
      requestTimeoutMs(
        process.env.WHATSAPP_MEDIA_UPLOAD_TIMEOUT_MS,
        DEFAULT_META_MEDIA_UPLOAD_TIMEOUT_MS
      )
    );

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
async function sendImageById(to, mediaId, caption, options = {}) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  try {
    const res = await fetchWithTimeout(
      url,
      {
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
          ...replyContext(options),
        }),
      },
      requestTimeoutMs(
        process.env.WHATSAPP_MESSAGE_TIMEOUT_MS,
        DEFAULT_META_MESSAGE_REQUEST_TIMEOUT_MS
      )
    );

    if (!res.ok) {
      const errBody = await res.text();
      console.error("WhatsApp image (by id) send failed:", res.status, errBody);
      return classifyWhatsappSendFailure(res.status, errBody);
    }
    const data = await res.json();
    return classifyWhatsappAcceptedResponse(data);
  } catch (err) {
    console.error("WhatsApp image (by id) send threw an error:", err);
    return interruptedDeliveryResult(err);
  }
}

async function sendStickerById(to, mediaId, options = {}) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "sticker",
        sticker: { id: mediaId },
        ...replyContext(options),
      }),
      },
      requestTimeoutMs(
        process.env.WHATSAPP_MESSAGE_TIMEOUT_MS,
        DEFAULT_META_MESSAGE_REQUEST_TIMEOUT_MS
      )
    );

    if (!res.ok) {
      const errBody = await res.text();
      console.error("WhatsApp sticker send failed:", res.status, errBody);
      return classifyWhatsappSendFailure(res.status, errBody);
    }
    const data = await res.json();
    return classifyWhatsappAcceptedResponse(data);
  } catch (err) {
    console.error("WhatsApp sticker send threw an error:", err);
    return interruptedDeliveryResult(err);
  }
}

/**
 * Sends an uploaded Ogg/Opus file as a native WhatsApp voice note. The
 * `voice: true` flag is what makes WhatsApp render the recording as a voice
 * message rather than a generic audio attachment.
 * @param {string} to - recipient's WhatsApp ID (phone number, no '+')
 * @param {string} mediaId - ID returned by uploadMedia()
 * @returns {Promise<{success: boolean, wamid: string|null}>} success is true if Meta
 *   *accepted* the message — this is NOT proof the patient's phone actually
 *   received it. A 200 here only means Meta queued it for delivery; the real
 *   outcome (delivered vs. failed, and why) arrives later via the status-update
 *   webhook (see parseStatusUpdates), matched back to this send by wamid.
 */
async function sendVoiceById(to, mediaId, options = {}) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  try {
    const res = await fetchWithTimeout(
      url,
      {
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
        ...replyContext(options),
      }),
      },
      requestTimeoutMs(
        process.env.WHATSAPP_MESSAGE_TIMEOUT_MS,
        DEFAULT_META_MESSAGE_REQUEST_TIMEOUT_MS
      )
    );

    if (!res.ok) {
      const errBody = await res.text();
      console.error("WhatsApp voice send failed:", res.status, errBody);
      return classifyWhatsappSendFailure(res.status, errBody);
    }
    const data = await res.json();
    return classifyWhatsappAcceptedResponse(data);
  } catch (err) {
    console.error("WhatsApp voice send threw an error:", err);
    return interruptedDeliveryResult(err);
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
 * Skips anything that isn't a genuine new inbound message — in particular,
 * delivery/read/failed status updates for messages *we* sent arrive as a
 * separate payload shape (value.statuses, no value.messages); see
 * parseStatusUpdates() below for those.
 */
function parseIncomingMessages(body) {
  try {
    const parsed = [];

    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        const value = change?.value;
        const contacts = value?.contacts || [];

        for (const message of value?.messages || []) {
          if (!message?.id || !message?.from) continue;

          // WhatsApp reactions are message metadata, not conversational turns.
          // They are parsed separately by parseReactionEvents() so a ❤️/👍 never
          // becomes an unsupported inbound message, triggers AI, or affects
          // follow-up/unread/attention state.
          if (message.type === "reaction") continue;

          const whatsappContact = contacts.find((contact) => contact.wa_id === message.from);
          const profileName = whatsappContact?.profile?.name?.trim() || null;
          const attribution = message.referral
            ? normalizeWhatsAppReferral(message.referral)
            : null;
          const sourceTimestamp = message.timestamp
            ? String(message.timestamp)
            : null;
          const replyToProviderMessageId = message.context?.id
            ? String(message.context.id)
            : null;
          const isForwarded = Boolean(
            message.context?.forwarded || message.context?.frequently_forwarded
          );
          const base = {
            id: message.id,
            from: message.from,
            profileName,
            ...(sourceTimestamp ? { timestamp: sourceTimestamp } : {}),
            ...(attribution ? { attribution } : {}),
            ...(replyToProviderMessageId ? { replyToProviderMessageId } : {}),
            ...(isForwarded ? { isForwarded: true } : {}),
          };

          if (message.type === "text") {
            parsed.push({
              ...base,
              text: message.text?.body || "",
              mediaId: null,
              mediaType: null,
              unsupportedType: null,
            });
          } else if (message.type === "audio") {
            parsed.push({
              ...base,
              text: null,
              mediaId: message.audio?.id || null,
              mediaType: "audio",
              unsupportedType: null,
            });
          } else if (message.type === "image") {
            parsed.push({
              ...base,
              text: message.image?.caption || null,
              mediaId: message.image?.id || null,
              mediaType: "image",
              unsupportedType: null,
            });
          } else if (message.type === "sticker") {
            // Stickers are genuine customer messages, but they are not treated
            // as photos for AI vision. The media is downloaded later for Inbox
            // display while the turn itself remains a neutral customer event.
            parsed.push({
              ...base,
              text: null,
              mediaId: message.sticker?.id || null,
              mediaType: "sticker",
              unsupportedType: null,
            });
          } else if (message.type === "button") {
            const buttonText = String(
              message.button?.text || message.button?.payload || ""
            ).trim();
            parsed.push({
              ...base,
              text: buttonText,
              mediaId: null,
              mediaType: null,
              unsupportedType: null,
              buttonPayload: message.button?.payload || null,
            });
          } else {
            parsed.push({
              ...base,
              text: null,
              mediaId: null,
              mediaType: null,
              unsupportedType: message.type || "unknown",
            });
          }
        }
      }
    }

    return parsed;
  } catch (err) {
    console.error("Failed to parse webhook payload:", err);
    return [];
  }
}

/**
 * Pulls out messages sent by staff from the WhatsApp Business app on a
 * coexistence number. These are outbound business messages, not customer
 * inbound messages, and must never enter the AI inbound path.
 */
function parseBusinessAppEchoes(body) {
  try {
    const parsed = [];

    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        if (change?.field !== "smb_message_echoes") continue;

        for (const message of change?.value?.message_echoes || []) {
          if (!message?.id || !message?.to) continue;
          const base = {
            id: message.id,
            from: message.from || null,
            to: message.to,
            timestamp: message.timestamp || null,
            type: message.type || "unknown",
            mediaId: null,
            text: null,
          };

          if (message.type === "text") {
            parsed.push({ ...base, text: message.text?.body || "" });
          } else if (message.type === "image") {
            parsed.push({
              ...base,
              text: message.image?.caption || null,
              mediaId: message.image?.id || null,
            });
          } else if (message.type === "audio") {
            parsed.push({ ...base, mediaId: message.audio?.id || null });
          } else if (message.type === "video") {
            parsed.push({
              ...base,
              text: message.video?.caption || null,
              mediaId: message.video?.id || null,
            });
          } else {
            parsed.push(base);
          }
        }
      }
    }

    return parsed;
  } catch (err) {
    console.error("Failed to parse WhatsApp Business App echo payload:", err);
    return [];
  }
}

/**
 * Pulls out customer reactions to WhatsApp messages. A reaction is an update to
 * an existing message, not a new customer turn. Meta removes the emoji field
 * when a customer removes a reaction, so normalize a missing emoji to "".
 */
function parseReactionEvents(body) {
  try {
    const parsed = [];

    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        for (const message of change?.value?.messages || []) {
          if (
            !message?.id ||
            !message?.from ||
            message.type !== "reaction" ||
            !message.reaction?.message_id
          ) {
            continue;
          }

          const emoji =
            typeof message.reaction.emoji === "string"
              ? message.reaction.emoji
              : "";

          parsed.push({
            id: message.id,
            from: message.from,
            targetMessageId: message.reaction.message_id,
            emoji,
            timestamp: message.timestamp || null,
          });
        }
      }
    }

    return parsed;
  } catch (err) {
    console.error("Failed to parse WhatsApp reaction payload:", err);
    return [];
  }
}

/**
 * Pulls out every delivery-status update from a WhatsApp webhook payload —
 * the async 'sent' / 'delivered' / 'read' / 'failed' callbacks Meta sends
 * for messages *we* sent (staff replies, AI replies, promo images). These
 * arrive as a separate payload shape from inbound patient messages: no
 * value.messages, just value.statuses. parseIncomingMessages() above
 * silently skips these; this is the counterpart that actually reads them.
 * @returns {Array<{wamid: string, status: string, errorCode: number|null,
 *   errorTitle: string|null, errorMessage: string|null}>}
 */
function parseStatusUpdates(body) {
  try {
    const parsed = [];

    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        for (const status of change?.value?.statuses || []) {
          if (!status?.id || !status?.status) continue;
          const firstError = status.errors?.[0] || null;
          parsed.push({
            wamid: status.id,
            status: status.status,
            errorCode: firstError?.code ?? null,
            errorTitle: firstError?.title || null,
            errorMessage: firstError?.error_data?.details || firstError?.message || null,
          });
        }
      }
    }

    return parsed;
  } catch (err) {
    console.error("Failed to parse webhook status payload:", err);
    return [];
  }
}

module.exports = {
  DEFAULT_META_MEDIA_UPLOAD_TIMEOUT_MS,
  DEFAULT_META_MESSAGE_REQUEST_TIMEOUT_MS,
  TRANSIENT_SEND_ERROR_CODES,
  TRANSIENT_SEND_HTTP_STATUSES,
  classifyWhatsappAcceptedResponse,
  classifyWhatsappSendFailure,
  fetchWithTimeout,
  interruptedDeliveryResult,
  parseWhatsappApiError,
  sendMessage,
  sendImage,
  uploadMedia,
  sendImageById,
  sendStickerById,
  sendVoiceById,
  downloadMedia,
  parseIncomingMessages,
  parseReactionEvents,
  parseBusinessAppEchoes,
  parseStatusUpdates,
};
