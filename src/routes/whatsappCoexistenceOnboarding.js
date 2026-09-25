const crypto = require("crypto");
const express = require("express");
const onboardingRepo = require("../db/whatsappCoexistenceOnboardingRepo");
const {
  WhatsAppCoexistenceOnboardingError,
  completeEmbeddedSignup,
  publicConfig,
  safeSessionInfo,
} = require("../services/whatsappCoexistenceOnboardingService");

const router = express.Router();
const NONCE_BYTES = 24;

function requireAdministrator(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({
      error: "Only administrators can manage WhatsApp coexistence onboarding.",
    });
  }
  next();
}

function issueNonce(req) {
  const nonce = crypto.randomBytes(NONCE_BYTES).toString("base64url");
  req.session.whatsappCoexistenceOnboardingNonce = nonce;
  return nonce;
}

function consumeNonce(req, supplied) {
  const expected = String(
    req.session?.whatsappCoexistenceOnboardingNonce || ""
  );
  if (req.session) {
    delete req.session.whatsappCoexistenceOnboardingNonce;
  }

  const actual = String(supplied || "");
  if (!expected || !actual) return false;

  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function serializeAttempt(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    status: row.status,
    wabaId: row.waba_id || null,
    phoneNumberId: row.phone_number_id || null,
    displayPhoneNumber: row.display_phone_number || null,
    verifiedName: row.verified_name || null,
    coexistenceReady: row.coexistence_ready === true,
    eventVersion: row.event_version == null ? null : Number(row.event_version),
    tokenExpiresAt: row.token_expires_at || null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    startedBy: row.started_by || null,
    createdAt: row.created_at || null,
  };
}

router.use(requireAdministrator);

router.get("/config", async (req, res) => {
  try {
    const latest = await onboardingRepo.getLatest();
    return res.json({
      ...publicConfig(process.env),
      nonce: issueNonce(req),
      latestAttempt: serializeAttempt(latest),
      activationAutomatic: false,
      safety:
        "Completing Embedded Signup validates the WABA and phone only. It does not change runtime credentials, register the phone, enable coexistence, or move the live webhook.",
    });
  } catch (err) {
    console.error("Failed to load WhatsApp coexistence onboarding config:", err);
    return res.status(500).json({
      error: "Something went wrong loading WhatsApp coexistence onboarding.",
    });
  }
});

router.post("/complete", async (req, res) => {
  const code = String(req.body?.code || "").trim();
  const sessionInfo = safeSessionInfo(req.body?.sessionInfo);
  const startedBy = req.session?.username || req.user?.username || null;

  if (!consumeNonce(req, req.body?.nonce)) {
    return res.status(409).json({
      error: "This onboarding session expired or was already used. Start Embedded Signup again.",
      code: "WHATSAPP_COEXISTENCE_ONBOARDING_NONCE_INVALID",
    });
  }

  try {
    const result = await completeEmbeddedSignup({
      code,
      sessionInfo,
      env: process.env,
    });

    const recorded = await onboardingRepo.recordValidated({
      wabaId: result.waba.id,
      phoneNumberId: result.phone.id,
      displayPhoneNumber: result.phone.displayPhoneNumber,
      verifiedName: result.phone.verifiedName,
      coexistenceReady: result.phone.coexistenceReady,
      eventVersion: result.eventVersion,
      tokenExpiresAt: result.tokenExpiresAt,
      startedBy,
    });

    return res.json({
      ...result,
      attempt: serializeAttempt(recorded),
    });
  } catch (err) {
    const onboardingError =
      err instanceof WhatsAppCoexistenceOnboardingError
        ? err
        : new WhatsAppCoexistenceOnboardingError(
            "WhatsApp coexistence onboarding could not be completed.",
            {
              code: "WHATSAPP_COEXISTENCE_ONBOARDING_FAILED",
              status: 500,
              retrySafe: true,
              cause: err,
            }
          );

    try {
      await onboardingRepo.recordFailed({
        wabaId: sessionInfo?.data?.waba_id || null,
        eventVersion: sessionInfo?.version || null,
        errorCode: onboardingError.code,
        errorMessage: onboardingError.message,
        startedBy,
      });
    } catch (recordErr) {
      console.error(
        "Failed to record WhatsApp coexistence onboarding failure:",
        recordErr
      );
    }

    if (onboardingError.status >= 500) {
      console.error(
        "WhatsApp coexistence Embedded Signup completion failed:",
        onboardingError
      );
    }

    return res.status(onboardingError.status || 400).json({
      error: onboardingError.message,
      code: onboardingError.code,
      retrySafe: onboardingError.retrySafe !== false,
      ...(onboardingError.details ? { details: onboardingError.details } : {}),
    });
  }
});

module.exports = router;
module.exports.consumeNonce = consumeNonce;
module.exports.issueNonce = issueNonce;
module.exports.requireAdministrator = requireAdministrator;
module.exports.serializeAttempt = serializeAttempt;
