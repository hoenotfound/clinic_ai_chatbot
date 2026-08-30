const GRAPH_API_VERSION = "v26.0";
const MAX_REMOTE_MEDIA_BYTES = 16 * 1024 * 1024;

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
    return {
      token: process.env.INSTAGRAM_ACCESS_TOKEN,
      senderId: process.env.INSTAGRAM_ACCOUNT_ID,
      baseUrl: "https://graph.instagram.com",
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

  const url =
    `${config.baseUrl}/${GRAPH_API_VERSION}/${config.senderId}/conversations` +
    `?platform=instagram&fields=${encodeURIComponent("messages.limit(1){message,from,created_time}")}` +
    `&access_token=${encodeURIComponent(config.token)}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    console.log(`[meta-webhook debug] fetchLatestConversationMessage HTTP ${response.status}, ok=${response.ok}`);
    console.log(`[meta-webhook debug] fetchLatestConversationMessage raw response:`, JSON.stringify(data));
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
    console.log(`[meta-webhook debug] fetchMessageById(${mid}) HTTP ${response.status}, ok=${response.ok}`);
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
      // TEMPORARY DIAGNOSTIC — logs the raw Graph API response for a
      // fetched message_edit event so we can see its actual field names.
      console.log(`[meta-webhook debug] fetchMessageById(${mid}) raw response:`, JSON.stringify(data));

      // The direct by-ID fetch has been observed to return an empty object
      // for some message_edit events even on a 200 response. Fall back to
      // pulling the most recent message from the conversations list.
      if (!data?.from?.id || typeof data?.message !== "string") {
        console.log(`[meta-webhook debug] falling back to conversations lookup for ${mid}`);
        data = await fetchLatestConversationMessage(channel);
        console.log(`[meta-webhook debug] conversations fallback result:`, JSON.stringify(data));
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
      if (!message?.mid || !senderId) continue;

      // Instagram includes outgoing echoes in the messages subscription.
      // Messenger may also deliver echoes depending on subscribed fields.
      if (message.is_echo || message.is_self || String(senderId) === String(entry?.id)) {
        continue;
      }
      if (message.is_deleted) continue;

      const attachment = firstAttachment(message);
      const attachmentType = attachment?.type || null;
      const mediaUrl = attachment?.payload?.url || null;

      if (attachmentType === "image") {
        parsed.push({
          id: message.mid,
          from: String(senderId),
          channel,
          profileName: null,
          text: message.text || null,
          mediaId: null,
          mediaUrl,
          mediaType: "image",
          unsupportedType: mediaUrl ? null : "image-without-url",
        });
      } else if (attachmentType === "audio") {
        parsed.push({
          id: message.mid,
          from: String(senderId),
          channel,
          profileName: null,
          text: message.text || null,
          mediaId: null,
          mediaUrl,
          mediaType: "audio",
          unsupportedType: mediaUrl ? null : "audio-without-url",
        });
      } else if (attachmentType) {
        parsed.push({
          id: message.mid,
          from: String(senderId),
          channel,
          profileName: null,
          text: message.text || null,
          mediaId: null,
          mediaUrl,
          mediaType: null,
          unsupportedType: attachmentType,
        });
      } else if (typeof message.text === "string") {
        parsed.push({
          id: message.mid,
          from: String(senderId),
          channel,
          profileName: null,
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
  sendText,
  sendImage,
  parseIncomingMessages,
  resolveMessageEditEvents,
  downloadMedia,
};
