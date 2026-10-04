const contactsRepo = require("../db/contactsRepo");
const messagingRuntimeHealthRepo = require("../db/messagingRuntimeHealthRepo");
const promoImagesRepo = require("../db/promoImagesRepo");
const whatsapp = require("./whatsappService");
const meta = require("./metaMessagingService");
const metaAttachments = require("./metaAttachmentService");
const mediaStorage = require("./mediaStorageService");
const audioConvert = require("./audioConvertService");
const messagingPolicy = require("./whatsappPolicyService");

function channelOf(contactOrIncoming) {
  return contactOrIncoming?.channel || "whatsapp";
}

function labelForChannel(channel) {
  if (channel === "facebook") return "Facebook Messenger";
  if (channel === "instagram") return "Instagram";
  return "WhatsApp";
}

function recipientFor(contact) {
  const channel = channelOf(contact);
  return channel === "whatsapp"
    ? contact.whatsapp_number
    : contact.channel_user_id;
}

function rejectedError(channel) {
  const label = labelForChannel(channel);
  return `${label} did not accept this message. Check the reply window or connection and try again.`;
}

function staffModeChangedResult() {
  return {
    success: false,
    wamid: null,
    externalMessageId: null,
    error: "This conversation is no longer in Staff mode.",
  };
}

async function preSendCancelled(options = {}) {
  if (typeof options.preSendCheck !== "function") return null;

  try {
    const allowed = await options.preSendCheck();
    if (allowed === true) return null;
    return {
      success: false,
      wamid: null,
      externalMessageId: null,
      cancelled: true,
      error: null,
    };
  } catch (err) {
    console.error("Final pre-send eligibility check failed:", err);
    return {
      success: false,
      wamid: null,
      externalMessageId: null,
      cancelled: true,
      preSendCheckFailed: true,
      error: "Message send cancelled because final eligibility could not be verified.",
    };
  }
}

async function notifyProviderMessageId(options, result, channel) {
  if (
    !result?.success ||
    !result.externalMessageId ||
    typeof options?.onProviderMessageId !== "function"
  ) {
    return;
  }
  try {
    await options.onProviderMessageId(String(result.externalMessageId));
  } catch (err) {
    // The provider already accepted this send. Alias persistence is best-effort
    // here; the caller still stores the final provider id as a second guard.
    console.error(
      `Failed to record ${labelForChannel(channel)} provider message id ${result.externalMessageId}:`,
      err
    );
  }
}

function recordAcceptedSocialOutbound(channel, result) {
  if (!result?.success || !["facebook", "instagram"].includes(channel)) {
    return result;
  }

  // Operational telemetry must never become a dependency of message delivery.
  // The Meta call has already succeeded, so record only the channel + timestamp
  // on a best-effort basis and never await this write in the customer path.
  // Unit CI intentionally provides TEST_DATABASE_URL rather than DATABASE_URL,
  // so ordinary mocked messaging tests do not open an unrelated database pool.
  if (process.env.DATABASE_URL) {
    messagingRuntimeHealthRepo.recordOutboundAccepted(channel).catch((err) => {
      console.error(`Failed to record ${labelForChannel(channel)} outbound health:`, err);
    });
  }
  return result;
}

async function trackSocialOutbound(channel, operation) {
  const result = await operation;
  return recordAcceptedSocialOutbound(channel, result);
}

async function freeformGuard(contact, purpose = "service") {
  try {
    const policy = await messagingPolicy.checkFreeformAllowed(contact, new Date(), {
      purpose,
    });
    return {
      blocked: policy.allowed ? null : messagingPolicy.blockedSendResult(policy),
      policy,
    };
  } catch (err) {
    // The policy gate is deliberately fail-closed, but a temporary database
    // problem should still look like a normal failed delivery to callers. This
    // lets Inbox/retry/scheduler paths persist a clear failure instead of
    // throwing after an outbound row has already been saved.
    const label = labelForChannel(channelOf(contact));
    console.error(`Failed to verify ${label} messaging-policy state:`, err);
    const policy = {
      allowed: false,
      code: "policy_state_unavailable",
      message:
        `${label} send blocked because messaging-policy state could not be verified. Please retry after the connection recovers.`,
    };
    return {
      blocked: messagingPolicy.blockedSendResult(policy),
      policy,
    };
  }
}

function optionsForPolicy(options, policy) {
  return policy?.humanAgentRequired === true
    ? { ...options, humanAgent: true }
    : options;
}

async function stillInStaffMode(contact) {
  // Voice retries or lower-level calls that are not tied to an active Staff
  // takeover keep their existing behavior. The Inbox voice route always passes
  // a persisted human-mode contact, so it receives the race-condition guard.
  if (contact?.mode !== "human" || !contact?.id) return true;

  try {
    const latest = await contactsRepo.getContactById(contact.id);
    return !!latest && latest.mode === "human";
  } catch (err) {
    // Fail closed here: once the media has uploaded, do not risk delivering a
    // staff voice message if we cannot confirm that the takeover is still active.
    console.error(`Failed to confirm Staff mode for contact ${contact.id}:`, err);
    return false;
  }
}

function temporaryMediaFailure(channel, err) {
  const label = labelForChannel(channel);
  console.error(`${label} temporary media preparation failed:`, err);
  return {
    success: false,
    wamid: null,
    externalMessageId: null,
    error: `The media could not be prepared for ${label}. Please try again.`,
  };
}

async function withTemporaryMediaUrl(contact, buffer, mimeType, deliver) {
  const channel = channelOf(contact);
  let temporary = null;
  try {
    temporary = await mediaStorage.uploadTemporaryMedia(buffer, mimeType, {
      contactId: contact?.id || channel,
    });
    return await deliver(temporary.url);
  } catch (err) {
    return temporaryMediaFailure(channel, err);
  } finally {
    if (temporary?.key) {
      mediaStorage.scheduleTemporaryMediaDelete(temporary.key);
    }
  }
}

function storedPromoImageId(imageUrl) {
  const raw = typeof imageUrl === "string" ? imageUrl.trim() : "";
  if (!raw) return null;

  try {
    // Settings-managed media may use the legacy public promotion path or the
    // authenticated Before/After preview path. Matching by pathname keeps
    // existing saved URLs working across Render/custom-domain migrations.
    const parsed = new URL(raw, "https://stored-config.invalid");
    const match = /^\/(?:promo-images|api\/config\/result-media\/image)\/(\d+)\/?$/.exec(
      parsed.pathname
    );
    if (!match) return null;
    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function storedImageFilename(id, mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  const extension = normalized === "image/png" ? "png" : "jpg";
  return `promo-${id}.${extension}`;
}

async function sendStoredFacebookImage(contact, imageUrl, caption, options = {}) {
  const imageId = storedPromoImageId(imageUrl);
  if (!imageId) return null;

  let image;
  try {
    image = await promoImagesRepo.getImage(imageId);
  } catch (err) {
    console.error(`Failed to load stored promo image ${imageId} for Facebook Messenger:`, err);
    return temporaryMediaFailure("facebook", err);
  }

  if (!image?.data || !["image/jpeg", "image/png"].includes(image.mime_type)) {
    return {
      success: false,
      wamid: null,
      externalMessageId: null,
      error: "The stored promotion image is missing or invalid. Please upload it again.",
    };
  }

  let captionSent = false;
  let captionProviderMessageId = null;
  if (caption?.trim() && options.skipCaption !== true) {
    const cancelled = await preSendCancelled(options);
    if (cancelled) return cancelled;
    // Messenger keeps caption text separate from the media attachment. This is
    // the same ordering as the URL path: preserve customer context even if the
    // later binary attachment upload is rejected by Meta.
    const captionResult = await meta.sendText(
      "facebook",
      recipientFor(contact),
      caption.trim(),
      options
    );
    if (!captionResult.success) return captionResult;
    captionSent = true;
    captionProviderMessageId = captionResult.externalMessageId || null;
    await notifyProviderMessageId(options, captionResult, "facebook");
  }

  // Do not ask Meta to fetch our /promo-images/:id URL. In production Meta can
  // reject an otherwise valid Render-hosted image with (#100) Upload failed.
  // The exact JPG/PNG bytes are already in Postgres, so upload them directly to
  // Messenger's message_attachments endpoint and send the returned attachment.
  const cancelled = await preSendCancelled(options);
  if (cancelled) {
    if (!captionSent) return cancelled;
    return {
      success: false,
      wamid: null,
      externalMessageId: null,
      cancelled: false,
      partialCaptionSent: true,
      captionProviderMessageId,
      error:
        "Staff activity took over the conversation before the image could be sent.",
    };
  }

  const result = await trackSocialOutbound(
    "facebook",
    metaAttachments.sendBuffer(
      "facebook",
      recipientFor(contact),
      "image",
      Buffer.from(image.data, "base64"),
      image.mime_type,
      storedImageFilename(imageId, image.mime_type),
      options
    )
  );
  await notifyProviderMessageId(options, result, "facebook");
  if (!result.success && captionSent) {
    return {
      ...result,
      partialCaptionSent: true,
      captionProviderMessageId,
    };
  }
  return result;
}

async function sendText(contact, text, options = {}) {
  const channel = channelOf(contact);
  const guard = await freeformGuard(contact, options.purpose);
  if (guard.blocked) return guard.blocked;
  const sendOptions = optionsForPolicy(options, guard.policy);

  const cancelled = await preSendCancelled(sendOptions);
  if (cancelled) return cancelled;

  if (channel === "whatsapp") {
    return whatsapp.sendMessage(contact.whatsapp_number, text);
  }
  const result = await trackSocialOutbound(
    channel,
    meta.sendText(channel, recipientFor(contact), text, sendOptions)
  );
  await notifyProviderMessageId(sendOptions, result, channel);
  return result;
}

async function sendImageByUrl(contact, imageUrl, caption, options = {}) {
  const channel = channelOf(contact);
  const storedImageId = storedPromoImageId(imageUrl);

  // Never ask WhatsApp or Instagram to fetch a permanent Settings image URL.
  // Load our stored bytes server-side and use the provider upload path instead.
  // Facebook already has a specialized stored-image path below that preserves
  // its caption/image race handling.
  if (storedImageId && channel !== "facebook") {
    let image;
    try {
      image = await promoImagesRepo.getImage(storedImageId);
    } catch (err) {
      console.error(`Failed to load stored image ${storedImageId} for ${channel}:`, err);
      return temporaryMediaFailure(channel, err);
    }
    if (!image?.data || !["image/jpeg", "image/png"].includes(image.mime_type)) {
      return {
        success: false,
        wamid: null,
        externalMessageId: null,
        error: "The stored image is missing or invalid. Please upload it again.",
      };
    }
    return sendImageBuffer(
      contact,
      Buffer.from(image.data, "base64"),
      image.mime_type,
      caption,
      storedImageFilename(storedImageId, image.mime_type),
      options
    );
  }

  const guard = await freeformGuard(contact, options.purpose);
  if (guard.blocked) return guard.blocked;
  const sendOptions = optionsForPolicy(options, guard.policy);
  if (channel === "whatsapp") {
    const cancelled = await preSendCancelled(sendOptions);
    if (cancelled) return cancelled;
    return whatsapp.sendImage(contact.whatsapp_number, imageUrl, caption);
  }

  if (channel === "facebook") {
    const storedResult = await sendStoredFacebookImage(contact, imageUrl, caption, sendOptions);
    if (storedResult) return storedResult;
  }

  const cancelled = await preSendCancelled(sendOptions);
  if (cancelled) return cancelled;
  return trackSocialOutbound(
    channel,
    meta.sendImage(
      channel,
      recipientFor(contact),
      imageUrl,
      caption,
      sendOptions
    )
  );
}

async function sendImageBuffer(contact, buffer, mimeType, caption, filename = "image", options = {}) {
  const channel = channelOf(contact);
  // Check policy before uploading bytes or sending a separate social caption.
  const guard = await freeformGuard(contact, options.purpose);
  if (guard.blocked) return guard.blocked;
  const sendOptions = optionsForPolicy(options, guard.policy);
  const initialCancellation = await preSendCancelled(sendOptions);
  if (initialCancellation) return initialCancellation;

  if (channel === "whatsapp") {
    const mediaId = await whatsapp.uploadMedia(buffer, mimeType, filename);
    if (!mediaId) {
      return {
        success: false,
        wamid: null,
        error: "The image could not be uploaded to WhatsApp.",
      };
    }
    const cancelled = await preSendCancelled(sendOptions);
    if (cancelled) return cancelled;
    return whatsapp.sendImageById(
      contact.whatsapp_number,
      mediaId,
      caption || undefined
    );
  }

  let captionSent = false;
  let captionProviderMessageId = null;
  if (caption?.trim() && options.skipCaption !== true) {
    // Do not mark the whole operation healthy from this partial caption send.
    // If the companion image fails, Setup Status should still show the failure
    // until a later complete social send succeeds.
    const captionResult = await meta.sendText(
      channel,
      recipientFor(contact),
      caption.trim(),
      sendOptions
    );
    if (!captionResult.success) return captionResult;
    captionSent = true;
    captionProviderMessageId = captionResult.externalMessageId || null;
    await notifyProviderMessageId(sendOptions, captionResult, channel);
  }

  const lateCancellation = await preSendCancelled(sendOptions);
  if (lateCancellation) {
    if (!captionSent) return lateCancellation;
    return {
      success: false,
      wamid: null,
      externalMessageId: null,
      cancelled: false,
      partialCaptionSent: true,
      captionProviderMessageId,
      error: "Staff activity took over the conversation before the image could be sent.",
    };
  }

  // Live Instagram testing showed that this Page-linked Instagram setup can
  // upload a reusable attachment but rejects the later attachment_id POST.
  // The Send API supports media URLs, so expose only a disposable R2 copy via
  // a short-lived presigned URL. Facebook Messenger keeps its binary upload.
  if (channel === "instagram") {
    const result = await withTemporaryMediaUrl(contact, buffer, mimeType, async (mediaUrl) => {
      const cancelled = await preSendCancelled(sendOptions);
      if (cancelled) return cancelled;
      return metaAttachments.sendUrlAttachment(
        channel,
        recipientFor(contact),
        "image",
        mediaUrl,
        sendOptions
      );
    });
    const tracked = recordAcceptedSocialOutbound(channel, result);
    await notifyProviderMessageId(sendOptions, tracked, channel);
    if (!tracked.success && captionSent) {
      return {
        ...tracked,
        partialCaptionSent: true,
        captionProviderMessageId,
      };
    }
    return tracked;
  }

  const result = await trackSocialOutbound(
    channel,
    metaAttachments.sendBuffer(
      channel,
      recipientFor(contact),
      "image",
      buffer,
      mimeType,
      filename,
      sendOptions
    )
  );
  await notifyProviderMessageId(sendOptions, result, channel);
  if (!result.success && captionSent) {
    return {
      ...result,
      partialCaptionSent: true,
      captionProviderMessageId,
    };
  }
  return result;
}

async function sendAudioBuffer(contact, buffer, mimeType, filename = "voice.mp3", options = {}) {
  const channel = channelOf(contact);
  // Check policy before conversion or upload work on every supported channel.
  const guard = await freeformGuard(contact, options.purpose);
  if (guard.blocked) return guard.blocked;
  const sendOptions = optionsForPolicy(options, guard.policy);
  if (channel === "whatsapp") {
    const mediaId = await whatsapp.uploadMedia(buffer, mimeType, filename);
    if (!mediaId) {
      return {
        success: false,
        wamid: null,
        error: "The voice recording could not be uploaded to WhatsApp.",
      };
    }

    if (!(await stillInStaffMode(contact))) {
      return staffModeChangedResult();
    }

    return whatsapp.sendVoiceById(contact.whatsapp_number, mediaId);
  }

  if (channel === "instagram") {
    const instagramAudio = await audioConvert.convertToInstagramAudio(buffer, mimeType);
    if (!instagramAudio) {
      return {
        success: false,
        wamid: null,
        externalMessageId: null,
        error: "The voice recording could not be converted to an Instagram-supported audio format.",
      };
    }

    const result = await withTemporaryMediaUrl(
      contact,
      instagramAudio.buffer,
      instagramAudio.mimeType,
      async (mediaUrl) => {
        // Keep the race-condition protection added for PR #54: conversion and
        // upload can both take time, so re-check immediately before delivery.
        if (!(await stillInStaffMode(contact))) {
          return staffModeChangedResult();
        }
        return metaAttachments.sendUrlAttachment(
          channel,
          recipientFor(contact),
          "audio",
          mediaUrl,
          sendOptions
        );
      }
    );
    const tracked = recordAcceptedSocialOutbound(channel, result);
    await notifyProviderMessageId(sendOptions, tracked, channel);
    return tracked;
  }

  // Facebook Messenger keeps the attachment upload path. Active Staff sends
  // split upload from delivery so we can re-check ownership after the slow
  // upload finishes; retries/tests without an active takeover keep the simple
  // generic path.
  if (contact?.mode !== "human" || !contact?.id) {
    const result = await trackSocialOutbound(
      channel,
      metaAttachments.sendBuffer(
        channel,
        recipientFor(contact),
        "audio",
        buffer,
        mimeType,
        filename,
        sendOptions
      )
    );
    await notifyProviderMessageId(sendOptions, result, channel);
    return result;
  }

  const uploaded = await metaAttachments.uploadAttachment(
    channel,
    "audio",
    buffer,
    mimeType,
    filename
  );
  if (!uploaded.success) {
    return {
      success: false,
      wamid: null,
      externalMessageId: null,
      error: uploaded.error,
    };
  }

  if (!(await stillInStaffMode(contact))) {
    return staffModeChangedResult();
  }

  const result = await trackSocialOutbound(
    channel,
    metaAttachments.sendAttachmentId(
      channel,
      recipientFor(contact),
      "audio",
      uploaded.attachmentId,
      sendOptions
    )
  );
  await notifyProviderMessageId(sendOptions, result, channel);
  return result;
}

async function downloadIncomingMedia(incoming) {
  const channel = channelOf(incoming);
  if (channel === "whatsapp") {
    return incoming.mediaId ? whatsapp.downloadMedia(incoming.mediaId) : null;
  }
  return incoming.mediaUrl ? meta.downloadMedia(incoming.mediaUrl) : null;
}

module.exports = {
  labelForChannel,
  rejectedError,
  sendText,
  sendImageByUrl,
  sendImageBuffer,
  sendAudioBuffer,
  downloadIncomingMedia,
};