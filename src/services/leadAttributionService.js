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

  async function consumePendingForInbound(incoming) {
    const channel = incoming?.channel || "whatsapp";
    if (!["facebook", "instagram"].includes(channel) || !incoming?.from) return null;
    // If the message itself already contains referral data there is no pending
    // record required for attribution, but consuming any earlier record keeps a
    // stale OPEN_THREAD click from leaking into a later lead journey.
    return repo.takePending(channel, incoming.from);
  }

  async function captureForInbound({ lead, incoming, firstMessageId }) {
    if (!lead?.id || !incoming) return null;

    const channel = incoming.channel || "whatsapp";
    let attribution = incoming.attribution || null;

    // Messenger/Instagram OPEN_THREAD referrals can arrive before the message
    // itself. Prefer attribution attached to the message, otherwise consume the
    // most recent pending referral for this scoped user. If the message already
    // carries the referral, still discard any older pending value for this user.
    if (["facebook", "instagram"].includes(channel)) {
      const pending = await repo.takePending(channel, incoming.from);
      if (!isReferralAttribution(attribution) && pending) attribution = pending;
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
    consumePendingForInbound,
  };
}

const service = createLeadAttributionService();

module.exports = {
  ...service,
  createLeadAttributionService,
  isReferralAttribution,
};