          claimedJob = await processing.claimMetaResolutionByExternalId({
            channel,
            externalMessageId: mid,
          });
        } catch (err) {
          console.error(
            `[${channelLabel(channel)}] Failed to claim durable message_edit ${mid}:`,
            err
          );
          return null;
        }

        // Another worker/recovery sweep already owns it, or it is complete.
        if (!claimedJob) return null;
      }

      try {
        const incoming = await resolveMessageEditPayload({
          channel,
          mid,
          entryId,
          resolutionJobId: claimedJob?.id || null,
        });

        if (!incoming && claimedJob) {
          await processing.markMetaResolutionCompleted(claimedJob.id);
        }
        return incoming;
      } catch (err) {
        if (claimedJob) {
          await processing.markMetaResolutionFailed(claimedJob.id, err).catch((markErr) => {
            console.error(
              `[${channelLabel(channel)}] Failed to persist message_edit resolution failure ${mid}:`,
              markErr
            );
          });
        }
        console.error(
          `[${channelLabel(channel)}] Failed to resolve message_edit ${mid}:`,
          err
        );
        return null;
      }
    })
  );

  return resolved.filter(Boolean);
}

function parseStaffEchoes(body) {
  const channel = messageEditChannel(body);
  if (!channel) return [];

  const parsed = [];
  for (const entry of body?.entry || []) {
    for (const event of entry?.messaging || []) {
      const message = event?.message;
      const senderId = event?.sender?.id;
      const recipientId = event?.recipient?.id;
      if (!message?.mid || !recipientId) continue;

      const isOutgoing =
        message.is_echo === true ||
        message.is_self === true ||
        (senderId != null && entry?.id != null && String(senderId) === String(entry.id));
      if (!isOutgoing) continue;

      // Facebook echoes can identify the originating app. Ignore only this
      // chatbot's own Meta app; a different connected CRM/app is external
      // activity and should still be reflected in the Inbox. Instagram often
      // omits app_id, so provider-message-id dedupe remains the primary guard.
      const ownAppId = String(
        process.env.META_APP_ID || process.env.WHATSAPP_APP_ID || ""
      ).trim();
      if (
        message.app_id != null &&
        (!ownAppId || String(message.app_id) === ownAppId)
      ) {
        // If META_APP_ID is not configured, retain the old conservative
        // behavior and ignore app-tagged echoes rather than risking a false
        // takeover. Once it is configured, echoes from other connected apps
        // are treated as external activity and shown in the Inbox.
        continue;
      }

      const attachment = firstAttachment(message);
      const attachmentType = attachment?.type || null;
      parsed.push({
        id: String(message.mid),
        channel,
        to: String(recipientId),
        text: typeof message.text === "string" ? message.text : null,
        mediaType: attachmentType,
        isDeleted: message.is_deleted === true,
      });
    }
  }
  return parsed;
}

function parseIncomingMessages(body) {
  const channel = messageEditChannel(body);
  if (!channel) return [];
