const attributionRepo = require("../db/leadAttributionRepo");
const {
  normalizeAttribution,
} = require("../utils/leadAttribution");

function isReferralAttribution(attribution) {
  return Boolean(
    attribution &&
    (
      attribution.adId ||
      attribution.sourceId ||
      attribution.referralRef ||
      attribution.referralSource ||
      attribution.ctwaClid ||
      attribution.sourceUrl ||
      attribution.rawReferral
    )
  );
}

function createLeadAttributionService(repo = attributionRepo) {
  async function rememberPendingReferral(incoming) {
    if (!incoming?.attributionOnly || !incoming?.attribution) return false;
    if (!["facebook", "instagram"].includes(incoming.channel)) return false;
    await repo.savePending(
      incoming.channel,
      incoming.from,
      incoming.attribution
    );
    return true;
  }

  async function captureForInbound({ lead, incoming, firstMessageId }) {
    if (!lead?.id || !incoming) return null;

    const channel = incoming.channel || "whatsapp";
    let attribution = incoming.attribution || null;

    // Messenger/Instagram OPEN_THREAD referrals can arrive before the message
    // itself. Prefer attribution attached to the message, otherwise consume the
    // most recent pending referral for this scoped user.
    if (!isReferralAttribution(attribution) && ["facebook", "instagram"].includes(channel)) {
      const pending = await repo.takePending(channel, incoming.from);
      if (pending) attribution = pending;
    }

    if (!attribution) attribution = normalizeAttribution(channel, null);

    return repo.createFirstTouch({
      leadId: lead.id,
      firstMessageId,
      attribution,
    });
  }

  return {
    captureForInbound,
    rememberPendingReferral,
  };
}

const service = createLeadAttributionService();

module.exports = {
  ...service,
  createLeadAttributionService,
  isReferralAttribution,
};