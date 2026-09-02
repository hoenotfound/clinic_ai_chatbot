const GRAPH_API_VERSION = "v26.0";

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
    // Instagram's current Messaging/Attachment Upload API is served from
    // graph.instagram.com. Text messaging in metaMessagingService keeps the
    // existing Page-linked Messenger path because it is already working for
    // this app, but uploaded Instagram assets must be uploaded and delivered
    // through the Instagram Graph host.
    return {
      token: process.env.INSTAGRAM_PAGE_ACCESS_TOKEN,
      senderId: process.env.INSTAGRAM_PAGE_ID,
      baseUrl: "https://graph.instagram.com",
    };
  }
  return { token: null, senderId: null, baseUrl: null };
}

function extractErrorText(data, fallback) {
  return data?.error?.error_user_msg || data?.error?.message || data?.message || fallback;
}

async function uploadAttachment(channel, type, buffer, mimeType, filename) {
  const config = getChannelConfig(channel);
  const label = channelLabel(channel);
  if (!config.token || !config.senderId) {
    return { success: false, attachmentId: null, error: `${label} is not configured on this server.` };
  }

  const url = `${config.baseUrl}/${GRAPH_API_VERSION}/${config.senderId}/message_attachments`;
  const form = new FormData();
  form.append(
    "message",
    JSON.stringify({ attachment: { type, payload: { is_reusable: true } } })
  );
  form.append("filedata", new Blob([buffer], { type: mimeType }), filename);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}` },
      body: form,
    });
    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }

    if (!response.ok || !data?.attachment_id) {
      const error = extractErrorText(
        data,
        raw || `${label} attachment upload returned HTTP ${response.status}.`
      );
      console.error(`${label} attachment upload failed:`, response.status, error);
      return { success: false, attachmentId: null, error };
    }

    return { success: true, attachmentId: data.attachment_id, error: null };
  } catch (err) {
    console.error(`${label} attachment upload threw an error:`, err);
    return {
      success: false,
      attachmentId: null,
      error: err?.message || `${label} attachment upload failed.`,
    };
  }
}

async function sendAttachmentId(channel, recipientId, type, attachmentId) {
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
    message: {
      attachment: {
        type,
        payload: { attachment_id: attachmentId },
      },
    },
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }

    if (!response.ok) {
      const error = extractErrorText(data, raw || `${label} returned HTTP ${response.status}.`);
      console.error(`${label} attachment send failed:`, response.status, error);
      return { success: false, wamid: null, externalMessageId: null, error };
    }

    return {
      success: true,
      wamid: null,
      externalMessageId: data?.message_id || data?.id || null,
      error: null,
    };
  } catch (err) {
    console.error(`${label} attachment send threw an error:`, err);
    return {
      success: false,
      wamid: null,
      externalMessageId: null,
      error: err?.message || `${label} attachment send failed.`,
    };
  }
}

async function sendBuffer(channel, recipientId, type, buffer, mimeType, filename) {
  const uploaded = await uploadAttachment(channel, type, buffer, mimeType, filename);
  if (!uploaded.success) {
    return {
      success: false,
      wamid: null,
      externalMessageId: null,
      error: uploaded.error,
    };
  }
  return sendAttachmentId(channel, recipientId, type, uploaded.attachmentId);
}

module.exports = {
  uploadAttachment,
  sendAttachmentId,
  sendBuffer,
};
