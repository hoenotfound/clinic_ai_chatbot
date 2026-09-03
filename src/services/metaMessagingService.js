const GRAPH_API_VERSION = "v26.0";
const MAX_REMOTE_MEDIA_BYTES = 16 * 1024 * 1024;
const PROFILE_FETCH_TIMEOUT_MS = 5000;
const PROFILE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PROFILE_FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;
const { normalizeSocialReferral } = require("../utils/leadAttribution");

const profileCache = new Map();
const profileRequests = new Map();

function channelLabel(channel) {
  if (channel === "facebook") return "Facebook Messenger";
  if (channel === "instagram") return "Instagram";
  return channel || "Meta";
}

function getChannelConfig(channel) {
  if (channel === "facebook") {
    return {
      token: process.env.FACEBOOK_PAGE_ACCESS_TOKEN,
      senderId: process.env.FACEBOOK_PAGE_ID,
      baseUrl: "https://graph.facebook.com",
    };
  }
  if (channel === "instagram") {
    // Instagram Messaging is configured through Messenger from Meta. It uses
    // the Facebook Page linked to the Instagram Professional account, a Page
    // access token generated under Messenger > Instagram settings, and the
    // graph.facebook.com Messenger Platform endpoint.
    return {
      token: process.env.INSTAGRAM_PAGE_ACCESS_TOKEN,
      senderId: process.env.INSTAGRAM_PAGE_ID,
      baseUrl: "https://graph.facebook.com",
    };
  }
  return { token: null, senderId: null, baseUrl: null };
}

function configured(channel) {
  const config = getChannelConfig(channel);
  return Boolean(config.token && config.senderId);
}

function extractErrorText(data, fallback) {
  return (
    data?.error?.error_user_msg ||
    data?.error?.message ||
    data?.message ||
    fallback
  );
}

function cleanProfileValue(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function cachedProfile(key) {
  const cached = profileCache.get(key);
  if (!cached) return { hit: false, value: null };
  if (cached.expiresAt <= Date.now()) {
    profileCache.delete(key);
    return { hit: false, value: null };
  }
  return { hit: true, value: cached.value };
}

/**
 * Fetches the customer-facing profile information for a Messenger PSID or
 * Instagram-scoped user ID. Webhook message payloads only contain the scoped
 * ID, so this lookup is what lets the portal show a real name/profile photo
 * instead of exposing the internal "facebook:<id>" / "instagram:<id>" key.
 *
 * Both channels use the Messenger Platform Graph host and their respective
 * Page access tokens. Lookups are cached and fail soft. A temporary Meta or
 * permission error must never block Inbox/message processing.
 */
async function fetchUserProfile(channel, userId) {
  if (channel !== "facebook" && channel !== "instagram") return null;

  const externalId = String(userId || "").trim();
  if (!externalId) return null;

  const config = getChannelConfig(channel);
  if (!config.token || !config.baseUrl) return null;

  const key = `${channel}:${externalId}`;
  const cached = cachedProfile(key);
  if (cached.hit) return cached.value;
  if (profileRequests.has(key)) return profileRequests.get(key);

  const request = (async () => {
    const fields = channel === "facebook"
      ? "first_name,last_name,profile_pic"
      : "name,username,profile_pic";
    const url =
      `${config.baseUrl}/${GRAPH_API_VERSION}/${encodeURIComponent(externalId)}` +
      `?fields=${encodeURIComponent(fields)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROFILE_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${config.token}` },
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.warn(
          `[${channelLabel(channel)}] Failed to fetch user profile ${externalId}: ` +
            extractErrorText(data, `HTTP ${response.status}`)
        );
        return null;
      }

      const firstName = cleanProfileValue(data?.first_name);
      const lastName = cleanProfileValue(data?.last_name);
      const fullFacebookName = [firstName, lastName].filter(Boolean).join(" ") || null;
      const username = cleanProfileValue(data?.username);
      const profileName = channel === "facebook"
        ? cleanProfileValue(data?.name) || fullFacebookName
        : cleanProfileValue(data?.name) || username;
      const photoUrl =
        cleanProfileValue(data?.profile_pic) ||
        cleanProfileValue(data?.profile_picture_url);

      if (!profileName && !photoUrl && !username) return null;
      return { profileName, photoUrl, username };
    } catch (err) {
      const reason = err?.name === "AbortError" ? "request timed out" : err?.message || String(err);
      console.warn(
        `[${channelLabel(channel)}] Failed to fetch user profile ${externalId}: ${reason}`
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  })();

  profileRequests.set(key, request);
  try {
    const profile = await request;
    profileCache.set(key, {
      value: profile,
      expiresAt:
        Date.now() + (profile ? PROFILE_CACHE_TTL_MS : PROFILE_FAILURE_CACHE_TTL_MS),
    });
    return profile;
  } finally {
    profileRequests.delete(key);
  }
}

async function postMessage(channel, recipientId, message) {
  const config = getChannelConfig(channel);
  const label = channelLabel(channel);
  if (!config.token || !config.senderId) {
    return {
      success: false,
      wamid: null,
      externalMessageId: null,
      error: `${label} is not configured on this server.`,
    };
  }

  const url = `${config.baseUrl}/${GRAPH_API_VERSION}/${config.senderId}/messages`;
  const body = {
    recipient: { id: String(recipientId) },
    message,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }

    if (!res.ok) {
      const error = extractErrorText(data, raw || `${label} returned HTTP ${res.status}.`);
      console.error(`${label} send failed:`, res.status, error);
      return { success: false, wamid: null, externalMessageId: null, error };
    }

    return {
      success: true,
      // Only WhatsApp WAMIDs should enter the WhatsApp delivery-status path.
      wamid: null,
      externalMessageId: data?.message_id || data?.id || null,
      error: null,
    };
  } catch (err) {
    console.error(`${label} send threw an error:`, err);
    return {
      success: false,
      wamid: null,
      externalMessageId: null,
      error: err?.message || `${label} send failed.`,
    };
  }
}

async function sendText(channel, recipientId, text) {
  return postMessage(channel, recipientId, { text });
}

async function sendImage(channel, recipientId, imageUrl, caption) {
  // Messenger and Instagram send the image attachment and caption as separate
  // messages. Keep the caption first so the customer has context even if the
  // media CDN later rejects the image request.
  if (caption?.trim()) {
    const captionResult = await sendText(channel, recipientId, caption.trim());
    if (!captionResult.success) return captionResult;
  }

  return postMessage(channel, recipientId, {
    attachment: {
      type: "image",
      payload: { url: imageUrl },
    },
  });
}

function firstAttachment(message) {
  return Array.isArray(message?.attachments) && message.attachments.length
    ? message.attachments[0]
    : null;
}

/**
 * Normalizes Facebook Messenger and Instagram messaging webhook events into
 * the same shape consumed by the existing AI pipeline. Echoes are skipped so
 * replies sent by this app never re-enter the AI as customer messages.
 */
async function fetchLatestConversationMessage(channel) {
  const config = getChannelConfig(channel);
  if (!config.token || !config.senderId) return null;

  const platformParam = channel === "instagram" ? "&platform=instagram" : "";
  const url =
    `${config.baseUrl}/${GRAPH_API_VERSION}/${config.senderId}/conversations` +
    `?fields=${encodeURIComponent("messages.limit(1){message,from,created_time}")}` +
    `${platformParam}&access_token=${encodeURIComponent(config.token)}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) {
      console.error(
        `[${channelLabel(channel)}] Failed to fetch conversations: ${extractErrorText(data, response.statusText)}`
      );
      return null;
    }
    // Conversations are typically returned most-recently-updated first.
    const latestConvo = data?.data?.[0];
    const latestMessage = latestConvo?.messages?.data?.[0];
    return latestMessage || null;
  } catch (err) {
    console.error(`[${channelLabel(channel)}] Error fetching conversations:`, err);
    return null;
  }
}

async function fetchMessageById(channel, mid) {
  const config = getChannelConfig(channel);
  if (!config.token || !mid) return null;

  const url = `${config.baseUrl}/${GRAPH_API_VERSION}/${encodeURIComponent(mid)}?fields=from,message&access_token=${encodeURIComponent(config.token)}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) {
      console.error(
        `[${channelLabel(channel)}] Failed to fetch message ${mid}: ${extractErrorText(data, response.statusText)}`
      );
      return null;
    }
    return data;
  } catch (err) {
    console.error(`[${channelLabel(channel)}] Error fetching message ${mid}:`, err);
    return null;
  }
}

// Instagram (and possibly Messenger) can deliver a message via a
// "message_edit" event instead of a plain "message" event — this includes
// genuine edits, but on some accounts/app configurations has also been
// observed for brand-new messages. Either way, the event payload itself
// only contains { mid, num_edit } with no text/sender, so the actual
// content has to be fetched separately via the Graph API before it can be
// processed like a normal incoming message.
async function resolveMessageEditEvents(body) {
  const channel = body?.object === "page"
    ? "facebook"
    : body?.object === "instagram"
      ? "instagram"
      : null;
  if (!channel) return [];

  const edits = [];
  for (const entry of body?.entry || []) {
    for (const event of entry?.messaging || []) {
      const mid = event?.message_edit?.mid;
      if (!mid) continue;
      edits.push({ mid, entryId: entry?.id });
    }
  }
  if (edits.length === 0) return [];

  const resolved = await Promise.all(
    edits.map(async ({ mid, entryId }) => {
      let data = await fetchMessageById(channel, mid);

      // The direct by-ID fetch has been observed to return an empty object
      // for some message_edit events even on a 200 response. Fall back to
      // pulling the most recent message from the conversations list.
      if (!data?.from?.id || typeof data?.message !== "string") {
        data = await fetchLatestConversationMessage(channel);
      }

      const senderId = data?.from?.id;
      const text = data?.message;
      if (!senderId || typeof text !== "string") return null;
      // Same self-echo guard as parseIncomingMessages.
      if (String(senderId) === String(entryId)) return null;
      return {
        id: mid,
        from: String(senderId),
        channel,
        profileName: null,
        text,
        mediaId: null,
        mediaUrl: null,
        mediaType: null,
        unsupportedType: null,
      };
    })
  );

  return resolved.filter(Boolean);
}

function parseIncomingMessages(body) {
  const channel = body?.object === "page"
    ? "facebook"
    : body?.object === "instagram"
      ? "instagram"
      : null;
  if (!channel) return [];

  const parsed = [];
  for (const entry of body?.entry || []) {
    for (const event of entry?.messaging || []) {
      const message = event?.message;
      const senderId = event?.sender?.id;
      const attribution = event?.referral
        ? normalizeSocialReferral(channel, event.referral)
        : null;

      // OPEN_THREAD referrals can arrive as their own webhook before the user
      // types. Keep them in the same queue as messages, but mark them so the
      // inbound claim service stores pending attribution without creating a
      // fake conversation message.
      if (!message?.mid || !senderId) {
        if (!message?.mid && senderId && attribution) {
          parsed.push({
            id: `referral:${entry?.id || "page"}:${event?.timestamp || "unknown"}:${senderId}`,
            from: String(senderId),
            channel,
            attributionOnly: true,
            attribution,
          });
        }
        continue;
      }

      // Instagram includes outgoing echoes in the messages subscription.
      // Messenger may also deliver echoes depending on subscribed fields.
      if (message.is_echo || message.is_self || String(senderId) === String(entry?.id)) {
        continue;
      }
      if (message.is_deleted) continue;

      const attachment = firstAttachment(message);
      const attachmentType = attachment?.type || null;
      const mediaUrl = attachment?.payload?.url || null;
      const base = {
        id: message.mid,
        from: String(senderId),
        channel,
        profileName: null,
        ...(attribution ? { attribution } : {}),
      };

      if (attachmentType === "image") {
        parsed.push({
          ...base,
          text: message.text || null,
          mediaId: null,
          mediaUrl,
          mediaType: "image",
          unsupportedType: mediaUrl ? null : "image-without-url",
        });
      } else if (attachmentType === "audio") {
        parsed.push({
          ...base,
          text: message.text || null,
          mediaId: null,
          mediaUrl,
          mediaType: "audio",
          unsupportedType: mediaUrl ? null : "audio-without-url",
        });
      } else if (attachmentType) {
        parsed.push({
          ...base,
          text: message.text || null,
          mediaId: null,
          mediaUrl,
          mediaType: null,
          unsupportedType: attachmentType,
        });
      } else if (typeof message.text === "string") {
        parsed.push({
          ...base,
          text: message.text,
          mediaId: null,
          mediaUrl: null,
          mediaType: null,
          unsupportedType: null,
        });
      }
    }
  }
  return parsed;
}

async function downloadMedia(url) {
  if (!url) return null;

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }
  if (!["https:", "http:"].includes(parsedUrl.protocol)) return null;

  try {
    const res = await fetch(parsedUrl, { redirect: "follow" });
    if (!res.ok) {
      console.error("Meta attachment download failed:", res.status);
      return null;
    }

    const advertisedLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(advertisedLength) && advertisedLength > MAX_REMOTE_MEDIA_BYTES) {
      console.error("Meta attachment download rejected: file exceeds 16MB.");
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_REMOTE_MEDIA_BYTES) {
      console.error("Meta attachment download rejected after download: file exceeds 16MB.");
      return null;
    }

    return {
      buffer,
      mimeType: (res.headers.get("content-type") || "application/octet-stream")
        .split(";")[0]
        .trim(),
    };
  } catch (err) {
    console.error("Meta attachment download threw an error:", err);
    return null;
  }
}

module.exports = {
  GRAPH_API_VERSION,
  configured,
  fetchUserProfile,
  sendText,
  sendImage,
  parseIncomingMessages,
  resolveMessageEditEvents,
  downloadMedia,
};
