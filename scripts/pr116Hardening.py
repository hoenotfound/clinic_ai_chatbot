from pathlib import Path
import re
import textwrap

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text()


def write(path, content):
    (ROOT / path).write_text(content)


def replace_once(path, old, new):
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one literal match, found {count}")
    write(path, text.replace(old, new, 1))


def regex_once(path, pattern, replacement, flags=0):
    text = read(path)
    new, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one regex match, found {count}")
    write(path, new)


# 1) Stable round-trip evidence: keep current latest inbound separately from the latest
# successful exact AI round trip, so a later human-takeover conversation does not erase
# already-proven channel readiness.
system_health = read("src/db/systemHealthRepo.js")
pattern = r'''    // Readiness evidence is intentionally separate from ordinary channel\n    // health\. It must belong to the latest inbound contact and to an explicitly\n    // tagged normal AI reply; staff, scheduled, follow-up and system-fallback\n    // sends cannot satisfy this query\.\n    queryable\.query\(\n      `WITH latest_inbound AS \([\s\S]*?\n    \),\n    messagingRuntimeHealthRepo\.listRuntimeHealth\(queryable\),'''
replacement = r'''    // Readiness evidence is intentionally separate from ordinary channel
    // health. Keep the latest customer inbound for current diagnostics, but also
    // preserve the latest successful exact AI round trip as durable go-live proof.
    // A later human-takeover conversation must not erase an already-proven channel.
    queryable.query(
      `WITH latest_inbound AS (
         SELECT DISTINCT ON (c.channel)
           c.channel,
           m.contact_id,
           m.id AS inbound_message_id,
           m.created_at AS last_inbound_at
         FROM contacts c
         JOIN messages m ON m.contact_id = c.id
         WHERE c.channel IN ('whatsapp', 'facebook', 'instagram')
           AND m.role = 'user'
         ORDER BY c.channel, m.created_at DESC, m.id DESC
       ), latest_inbound_evidence AS (
         SELECT
           li.channel,
           li.contact_id,
           li.inbound_message_id,
           li.last_inbound_at,
           MAX(e.attempted_at) FILTER (
             WHERE e.origin = 'ai_reply' AND e.accepted = false
           ) AS last_ai_reply_failure_at
         FROM latest_inbound li
         LEFT JOIN messages reply
           ON reply.contact_id = li.contact_id
          AND reply.role = 'assistant'
          AND reply.created_at > li.last_inbound_at
         LEFT JOIN outbound_message_evidence e
           ON e.message_id = reply.id
          AND e.contact_id = li.contact_id
          AND e.channel = li.channel
         GROUP BY li.channel, li.contact_id, li.inbound_message_id, li.last_inbound_at
       ), verified_round_trips AS (
         SELECT
           c.channel,
           reply.contact_id,
           inbound.id AS inbound_message_id,
           inbound.created_at AS inbound_at,
           e.accepted_at AS verified_reply_at,
           ROW_NUMBER() OVER (
             PARTITION BY c.channel
             ORDER BY e.accepted_at DESC, reply.id DESC
           ) AS channel_rank
         FROM outbound_message_evidence e
         JOIN messages reply
           ON reply.id = e.message_id
          AND reply.contact_id = e.contact_id
          AND reply.role = 'assistant'
         JOIN contacts c
           ON c.id = e.contact_id
          AND c.channel = e.channel
         JOIN LATERAL (
           SELECT inbound_message.id, inbound_message.created_at
           FROM messages inbound_message
           WHERE inbound_message.contact_id = reply.contact_id
             AND inbound_message.role = 'user'
             AND inbound_message.created_at < reply.created_at
           ORDER BY inbound_message.created_at DESC, inbound_message.id DESC
           LIMIT 1
         ) inbound ON true
         WHERE c.channel IN ('whatsapp', 'facebook', 'instagram')
           AND e.origin = 'ai_reply'
           AND e.accepted = true
       ), latest_verified_round_trip AS (
         SELECT
           channel,
           contact_id,
           inbound_message_id,
           inbound_at,
           verified_reply_at
         FROM verified_round_trips
         WHERE channel_rank = 1
       )
       SELECT
         channels.channel,
         lie.contact_id AS last_inbound_contact_id,
         lie.inbound_message_id AS last_inbound_message_id,
         lie.last_inbound_at,
         vrt.contact_id AS last_verified_round_trip_contact_id,
         vrt.inbound_message_id AS last_verified_round_trip_inbound_message_id,
         vrt.inbound_at AS last_verified_round_trip_inbound_at,
         vrt.verified_reply_at AS last_verified_ai_reply_at,
         lie.last_ai_reply_failure_at
       FROM (VALUES ('whatsapp'), ('instagram'), ('facebook')) AS channels(channel)
       LEFT JOIN latest_inbound_evidence lie ON lie.channel = channels.channel
       LEFT JOIN latest_verified_round_trip vrt ON vrt.channel = channels.channel
       ORDER BY channels.channel`
    ),
    messagingRuntimeHealthRepo.listRuntimeHealth(queryable),'''
new_system_health, count = re.subn(pattern, replacement, system_health, count=1)
if count != 1:
    raise SystemExit(f"src/db/systemHealthRepo.js: stable proof query replacement matched {count}")
write("src/db/systemHealthRepo.js", new_system_health)

replace_once(
    "src/db/systemHealthRepo.js",
    '''      lastInboundMessageId: readiness.last_inbound_message_id == null
        ? null
        : Number(readiness.last_inbound_message_id),
      lastVerifiedAutomatedReplyAt: readiness.last_verified_ai_reply_at || null,
      lastReadinessDeliveryFailureAt: readiness.last_ai_reply_failure_at || null,
      roundTripCorrelated: Boolean(
        readiness.last_inbound_at && readiness.last_verified_ai_reply_at
      ),''',
    '''      lastInboundMessageId: readiness.last_inbound_message_id == null
        ? null
        : Number(readiness.last_inbound_message_id),
      lastVerifiedRoundTripContactId: readiness.last_verified_round_trip_contact_id == null
        ? null
        : Number(readiness.last_verified_round_trip_contact_id),
      lastVerifiedRoundTripInboundMessageId: readiness.last_verified_round_trip_inbound_message_id == null
        ? null
        : Number(readiness.last_verified_round_trip_inbound_message_id),
      lastVerifiedRoundTripInboundAt: readiness.last_verified_round_trip_inbound_at || null,
      lastVerifiedAutomatedReplyAt: readiness.last_verified_ai_reply_at || null,
      lastReadinessDeliveryFailureAt: readiness.last_ai_reply_failure_at || null,
      roundTripCorrelated: Boolean(
        readiness.last_verified_round_trip_inbound_at && readiness.last_verified_ai_reply_at
      ),'''
)

# 2) Structured Setup Status reason codes instead of parsing human-facing summaries.
replace_once(
    "src/services/setupStatusService.js",
    '''    { lastWebhookAt }
  );''',
    '''    {
      lastWebhookAt,
      reason: lastWebhookAt ? null : "live_evidence_pending",
    }
  );'''
)
replace_once(
    "src/services/setupStatusService.js",
    '''        { lastActivityAt }
      );''',
    '''        {
          lastActivityAt,
          reason: lastActivityAt ? null : "live_evidence_pending",
        }
      );'''
)
replace_once(
    "src/provisioning/readinessVerifier.js",
    '''    status: check?.status || "missing",
    summary: check?.summary || "Check result was not returned.",''',
    '''    status: check?.status || "missing",
    reason: check?.reason || null,
    summary: check?.summary || "Check result was not returned.",'''
)

# 3) Shared Setup Status overview orchestration used by both Setup Status and Go Live.
shared_service = r'''const { createSetupStatusService } = require("./setupStatusService");
const setupStatusRepo = require("../db/setupStatusRepo");
const configRepo = require("../db/configRepo");
const aiService = require("./aiService");
const aiUsage = require("./aiUsageService");
const geminiSetupCheck = require("./geminiSetupCheckService");
const systemHealthService = require("./systemHealthService");

function formatCount(value) {
  return new Intl.NumberFormat("en-US").format(Number(value) || 0);
}

function formatMalaysiaTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-MY", {
    timeZone: "Asia/Kuala_Lumpur",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function failureCount(usage, kind) {
  return Number(
    (usage?.failuresByKind || []).find((item) => item.failureKind === kind)?.requests
  ) || 0;
}

function usesGeminiMetadataSetupCheck(env = process.env) {
  const preferred = String(env.AI_PROVIDER || "gemini").trim().toLowerCase();
  return preferred === "gemini" && aiService.getGeminiApiKeys(env).length > 0;
}

async function runAllGeminiMetadataChecks() {
  const batch = await geminiSetupCheck.checkAllGeminiConnections();

  await Promise.allSettled(batch.results.map((item) =>
    setupStatusRepo.recordAiCandidateSetupCheck({
      candidateKey: item.healthKey,
      provider: item.provider,
      status: item.status,
      failureKind: item.failureKind,
      at: item.checkedAt,
    })
  ));

  if (batch.readyCount <= 0) {
    const error = new Error("No configured Gemini key could access the configured model metadata.");
    error.code = "ALL_GEMINI_SETUP_CHECKS_FAILED";
    throw error;
  }

  return batch;
}

const setupStatusAi = {
  ...aiService,
  async getReply(messages, options = {}) {
    if (usesGeminiMetadataSetupCheck()) {
      await runAllGeminiMetadataChecks();
      return JSON.stringify({
        reply: "OK",
        outcome: "normal",
        treatment: null,
        branch: null,
        appointmentPreference: null,
      });
    }
    return aiService.getReply(messages, { ...options, privateSetupCheck: true });
  },
};

const setupStatus = createSetupStatusService({ ai: setupStatusAi });

async function loadCandidateSetupChecks() {
  if (!usesGeminiMetadataSetupCheck()) return [];
  try {
    return await setupStatusRepo.listAiCandidateSetupChecks();
  } catch (err) {
    console.warn("Could not load AI setup-check history:", err?.message || err);
    return [];
  }
}

async function addAiUsage(overview) {
  try {
    const [usage, setupCheckRows] = await Promise.all([
      aiUsage.getUsageSummary({ hours: 24 }),
      loadCandidateSetupChecks(),
    ]);
    const aiCheck = (overview?.checks || []).find((check) => check.key === "ai");
    const modelHealth = typeof aiService.getRuntimeGeminiModelHealth === "function"
      ? aiService.getRuntimeGeminiModelHealth()
      : [];
    if (aiCheck) {
      aiCheck.aiUsage = usage;
      aiCheck.geminiModelHealth = modelHealth;

      const setupByHealthKey = new Map(
        setupCheckRows.map((row) => [row.candidate_key, row])
      );
      const descriptors = typeof aiService.getCandidateHealthDescriptors === "function"
        ? aiService.getCandidateHealthDescriptors()
        : [];
      const healthKeyByDisplay = new Map(
        descriptors.map((item) => [`${item.provider}:${item.label}`, item.healthKey])
      );

      aiCheck.candidateHealth = (aiCheck.candidateHealth || []).map((candidate) => {
        const healthKey = healthKeyByDisplay.get(`${candidate.provider}:${candidate.label}`);
        const setupRow = healthKey ? setupByHealthKey.get(healthKey) : null;
        return {
          ...candidate,
          setupCheck: {
            status: setupRow?.last_status || "not_checked",
            failureKind: setupRow?.last_failure_kind || null,
            checkedAt: setupRow?.last_checked_at || null,
            successAt: setupRow?.last_success_at || null,
          },
        };
      });

      if (usesGeminiMetadataSetupCheck()) {
        aiCheck.setupCheckMode = "model_metadata";
        if (aiCheck.status === "ready") {
          const geminiChecks = aiCheck.candidateHealth
            .filter((candidate) => candidate.provider === "gemini")
            .map((candidate) => candidate.setupCheck)
            .filter((item) => item?.checkedAt);
          const readyChecks = geminiChecks.filter((item) => item.status === "ready").length;
          const totalKeys = Number(aiCheck.geminiKeyCount) || geminiChecks.length;
          aiCheck.summary = geminiChecks.length
            ? `${readyChecks}/${totalKeys} configured Gemini keys passed the latest metadata-only setup check. Run all checks does not generate AI text or consume prompt/output tokens.`
            : "Gemini credentials and the configured model are accessible. Run all checks uses metadata only and does not generate AI text or consume prompt/output tokens.";
        }
      }
      const usageText = usage.requests > 0
        ? `Tracked Gemini usage in the last 24h: ${formatCount(usage.requests)} request${usage.requests === 1 ? "" : "s"}, ${formatCount(usage.failedRequests)} failed, ${formatCount(usage.totalTokens)} total tokens.`
        : "No tracked Gemini usage has been recorded in the last 24h yet.";
      const modelUnavailable = failureCount(usage, "model_unavailable");
      const rateLimited = failureCount(usage, "rate_limit");
      const quotaExhausted = failureCount(usage, "quota_exhausted");
      const failureText = modelUnavailable || rateLimited || quotaExhausted
        ? ` Failures: ${formatCount(modelUnavailable)} model unavailable/503, ${formatCount(rateLimited)} rate limited, ${formatCount(quotaExhausted)} quota exhausted.`
        : "";
      const coolingModels = modelHealth.filter((item) => item.status === "cooling_down");
      const cooldownText = coolingModels.length
        ? ` Model cooldown active: ${coolingModels.map((item) => {
            const until = formatMalaysiaTime(item.cooldownUntil);
            return `${item.model}${until ? ` until ${until}` : ""}`;
          }).join(", ")}.`
        : "";
      aiCheck.summary = `${aiCheck.summary} ${usageText}${failureText}${cooldownText}`;
    }
    return { ...overview, aiUsage: usage, geminiModelHealth: modelHealth };
  } catch (err) {
    console.warn("Could not load AI usage summary:", err?.message || err);
    return overview;
  }
}

async function addSystemHealth(overview) {
  try {
    const systemHealth = await systemHealthService.getSystemHealth({
      checks: overview?.checks || [],
      aiUsage: overview?.aiUsage || null,
    });
    return { ...overview, systemHealth };
  } catch (err) {
    console.warn("Could not load operational health summary:", err?.message || err);
    return overview;
  }
}

async function addBusinessProfile(overview) {
  try {
    const businessProfile = await configRepo.getIndustrySetupStatus();
    return { ...overview, businessProfile };
  } catch (err) {
    console.warn("Could not load business profile status:", err?.message || err);
    return { ...overview, businessProfile: null };
  }
}

async function decorateOverview(overview) {
  const withHealth = await addSystemHealth(await addAiUsage(overview));
  return addBusinessProfile(withHealth);
}

module.exports = {
  addAiUsage,
  addBusinessProfile,
  addSystemHealth,
  decorateOverview,
  failureCount,
  runAllGeminiMetadataChecks,
  setupStatus,
  setupStatusAi,
  usesGeminiMetadataSetupCheck,
};
'''
write("src/services/setupStatusOverviewService.js", shared_service)

setup_route = read("src/routes/setupStatus.js")
setup_route = setup_route.replace('const { createSetupStatusService } = require("../services/setupStatusService");\n', '')
setup_route = setup_route.replace('const setupStatusRepo = require("../db/setupStatusRepo");\n', '')
setup_route = setup_route.replace('const aiUsage = require("../services/aiUsageService");\n', '')
setup_route = setup_route.replace('const systemHealthService = require("../services/systemHealthService");\n', '')
insert_after = 'const geminiSetupCheck = require("../services/geminiSetupCheckService");\n'
shared_import = '''const {
  addAiUsage,
  addBusinessProfile,
  addSystemHealth,
  decorateOverview,
  failureCount,
  runAllGeminiMetadataChecks,
  setupStatus,
  setupStatusAi,
  usesGeminiMetadataSetupCheck,
} = require("../services/setupStatusOverviewService");
'''
if shared_import not in setup_route:
    if insert_after not in setup_route:
        raise SystemExit("setupStatus.js: import anchor missing")
    setup_route = setup_route.replace(insert_after, insert_after + shared_import, 1)
setup_route, count = re.subn(
    r'\nfunction usesGeminiMetadataSetupCheck\([\s\S]*?\nconst setupStatus = createSetupStatusService\(\{ ai: setupStatusAi \}\);\n',
    '\n',
    setup_route,
    count=1,
)
if count != 1:
    raise SystemExit(f"setupStatus.js: setup AI block matched {count}")
setup_route, count = re.subn(
    r'\nfunction formatCount\([\s\S]*?\nasync function decorateOverview\(overview\) \{[\s\S]*?\n\}\n\nrouter\.use\(requireAdministrator\);',
    '\nrouter.use(requireAdministrator);',
    setup_route,
    count=1,
)
if count != 1:
    raise SystemExit(f"setupStatus.js: overview helper block matched {count}")
write("src/routes/setupStatus.js", setup_route)

# 4) Canonical v1 go-live evaluator with structured issues and stable proof handling.
go_live_service = r'''const {
  CHANNEL_CHECK_KEYS,
  evaluateReadiness,
} = require("../provisioning/readinessVerifier");
const {
  evaluateClientSetup,
  purchasedChannelContract,
} = require("./clientSetupService");

const GO_LIVE_SCHEMA_VERSION = 1;
const CHANNEL_LABELS = Object.freeze({
  whatsapp: "WhatsApp",
  facebook: "Facebook Messenger",
  instagram: "Instagram",
});

function timestampMs(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function uniqueIssues(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item) return false;
    const channels = Array.isArray(item.channels) ? item.channels.join(",") : "";
    const key = `${item.key || "unknown"}|${item.status || "unknown"}|${channels}|${item.summary || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function channelLabel(channel) {
  return CHANNEL_LABELS[channel] || channel;
}

function channelCheck(readiness, key) {
  return (readiness?.channelChecks || []).find((item) => item.key === key) || null;
}

function runtimeForChannel(readiness, channel) {
  return (readiness?.operationalHealth?.messaging || [])
    .find((item) => item.channel === channel) || null;
}

function channelsForIssue(item, requiredChannels = []) {
  if (Array.isArray(item?.channels) && item.channels.length) {
    return item.channels.filter((channel) => requiredChannels.includes(channel));
  }
  if (!item?.key) return [];
  return requiredChannels.filter((channel) => (
    item.key.startsWith(`${channel}_`)
    || (CHANNEL_CHECK_KEYS[channel] || []).includes(item.key)
  ));
}

function blockerBelongsToChannel(item, channel) {
  if (!item || !channel) return false;
  if (Array.isArray(item.channels) && item.channels.length) return item.channels.includes(channel);
  if (item.key?.startsWith(`${channel}_`)) return true;
  return (CHANNEL_CHECK_KEYS[channel] || []).includes(item.key);
}

function hasStableRoundTrip(runtime) {
  const inboundMs = timestampMs(runtime?.lastVerifiedRoundTripInboundAt);
  const replyMs = timestampMs(runtime?.lastVerifiedAutomatedReplyAt);
  const failureMs = timestampMs(runtime?.lastReadinessDeliveryFailureAt);
  return Boolean(
    inboundMs
    && replyMs
    && replyMs >= inboundMs
    && (!failureMs || failureMs <= replyMs)
  );
}

function classifyReadinessBlocker(item, readiness, requiredChannels) {
  if (!item?.key) return { kind: "hard", channels: [] };
  const channels = channelsForIssue(item, requiredChannels);
  const stableChannels = channels.filter((channel) => hasStableRoundTrip(runtimeForChannel(readiness, channel)));
  const unverifiedChannels = channels.filter((channel) => !stableChannels.includes(channel));

  if (/_round_trip_(?:inbound|outbound)$/.test(item.key)) {
    if (channels.length && unverifiedChannels.length === 0) return { kind: "ignore", channels };
    if (["missing", "stale", "warning"].includes(item.status)) {
      return { kind: "testing", channels: unverifiedChannels.length ? unverifiedChannels : channels };
    }
  }

  const check = channelCheck(readiness, item.key);
  if (
    check
    && check.configured === true
    && check.status === "warning"
    && check.reason === "live_evidence_pending"
  ) {
    if (channels.length && unverifiedChannels.length === 0) return { kind: "ignore", channels };
    return { kind: "testing", channels: unverifiedChannels.length ? unverifiedChannels : channels };
  }

  return { kind: "hard", channels };
}

function buildBusinessSetup(clientSetup) {
  const incomplete = Array.isArray(clientSetup?.incompleteRequired)
    ? clientSetup.incompleteRequired
    : [];
  return {
    ready: clientSetup?.requiredComplete === true,
    completed: Number(clientSetup?.requiredCompletedCount) || 0,
    total: Number(clientSetup?.requiredTotal) || 0,
    incomplete: incomplete.map((section) => ({
      id: section.id,
      label: section.label,
      missing: Array.isArray(section.missing) ? [...section.missing] : [],
    })),
    sections: Array.isArray(clientSetup?.sections)
      ? clientSetup.sections.map((section) => ({ ...section }))
      : [],
  };
}

function issueCategory(item, kind, channels) {
  if (item.key === "business_setup") return "business_setup";
  if (item.key === "business_profile") return "business_profile";
  if (item.key === "purchased_channels") return "provisioning";
  if (kind === "testing" || /_round_trip_(?:inbound|outbound)$/.test(item.key || "")) return "live_test";
  if (channels.length) return "channel_setup";
  return "system";
}

function issueAction(category, channels) {
  const labels = channels.map(channelLabel).join(" and ");
  switch (category) {
    case "business_setup":
      return "Complete the required Client Setup sections, save them, then run go-live checks again.";
    case "business_profile":
      return "Review the business-profile alignment details and correct the mismatched industry configuration.";
    case "provisioning":
      return "Set the server-owned PURCHASED_CHANNELS contract for this client, then redeploy or restart as required.";
    case "live_test":
      return `From a genuine customer account, message ${labels || "the purchased channel"}, allow the normal AI reply path to respond, then run go-live checks again.`;
    case "channel_setup":
      return `Review ${labels || "the channel"} credentials, webhook configuration and connection checks in Setup Status.`;
    default:
      return "Review the affected system check in Setup Status, fix the underlying issue, then run go-live checks again.";
  }
}

function remediationRoute(category) {
  if (category === "business_setup") return "/settings/client-setup";
  if (["business_profile", "channel_setup", "system"].includes(category)) return "/settings/setup";
  return null;
}

function decorateIssue(item, kind, requiredChannels) {
  const channels = channelsForIssue(item, requiredChannels);
  const category = issueCategory(item, kind, channels);
  return {
    ...item,
    category,
    severity: kind === "blocker" ? "error" : kind === "testing" ? "action_required" : "warning",
    channel: channels.length === 1 ? channels[0] : null,
    channels,
    action: issueAction(category, channels),
    remediationRoute: remediationRoute(category),
  };
}

function buildChannelSummary(channel, readiness, hardBlockers, testingRequired) {
  const checks = (CHANNEL_CHECK_KEYS[channel] || [])
    .map((key) => channelCheck(readiness, key))
    .filter(Boolean);
  const runtime = runtimeForChannel(readiness, channel);

  const latestInboundAt = runtime?.lastInboundAt || null;
  const verifiedInboundAt = runtime?.lastVerifiedRoundTripInboundAt || null;
  const replyAt = runtime?.lastVerifiedAutomatedReplyAt || null;
  const failureAt = runtime?.lastReadinessDeliveryFailureAt || null;
  const inboundVerified = Boolean(timestampMs(verifiedInboundAt));
  const aiReplyVerified = hasStableRoundTrip(runtime);
  const configured = checks.length > 0
    && checks.every((item) => item.configured === true)
    && runtime?.configured === true;
  const setupReady = checks.length > 0
    && checks.every((item) => (
      item.configured === true
      && (item.status === "ready" || (item.status === "warning" && item.reason === "live_evidence_pending" && aiReplyVerified))
    ));
  const runtimeReady = runtime?.status === "healthy";
  const channelHardBlockers = hardBlockers.filter((item) => blockerBelongsToChannel(item, channel));
  const channelTesting = testingRequired.filter((item) => blockerBelongsToChannel(item, channel));

  return {
    channel,
    label: channelLabel(channel),
    purchased: true,
    configured,
    setupReady,
    runtimeReady,
    inboundVerified,
    aiReplyVerified,
    ready: channelHardBlockers.length === 0 && channelTesting.length === 0,
    verificationState: channelHardBlockers.length
      ? "blocked"
      : channelTesting.length
        ? "needs_testing"
        : "ready",
    latestCustomerInboundAt: latestInboundAt,
    lastVerifiedRoundTripInboundAt: verifiedInboundAt,
    lastVerifiedAutomatedReplyAt: replyAt,
    lastReadinessDeliveryFailureAt: failureAt,
    checks,
    blockers: channelHardBlockers,
    testingRequired: channelTesting,
  };
}

function businessSetupBlocker(businessSetup) {
  if (businessSetup.ready) return null;
  const labels = businessSetup.incomplete.map((item) => item.label).filter(Boolean);
  return {
    key: "business_setup",
    status: "incomplete",
    summary: labels.length
      ? `Complete the required Client Setup sections: ${labels.join(", ")}.`
      : "Complete all required Client Setup sections before going live.",
  };
}

function channelContractBlocker(contract) {
  if (contract?.error) {
    return {
      key: "purchased_channels",
      status: "error",
      summary: contract.error,
    };
  }
  if (contract?.configured !== true || !Array.isArray(contract.channels) || contract.channels.length === 0) {
    return {
      key: "purchased_channels",
      status: "missing",
      summary: "The purchased messaging-channel contract is not configured for this client.",
    };
  }
  return null;
}

function evaluateGoLiveGate({
  config = {},
  clientSetup = null,
  setupOverview = null,
  env = process.env,
} = {}) {
  const completion = clientSetup || evaluateClientSetup(config, env);
  const businessSetup = buildBusinessSetup(completion);
  const contract = completion?.channelContract || purchasedChannelContract(env);
  const requiredChannels = Array.isArray(contract?.channels) ? contract.channels : [];
  const hardBlockers = [];
  const testingRequired = [];
  const warnings = [];

  const businessBlocker = businessSetupBlocker(businessSetup);
  if (businessBlocker) hardBlockers.push(businessBlocker);

  const contractBlocker = channelContractBlocker(contract);
  if (contractBlocker) hardBlockers.push(contractBlocker);

  let readiness = null;
  if (!setupOverview) {
    hardBlockers.push({
      key: "setup_status",
      status: "missing",
      summary: "Setup Status could not be loaded, so go-live readiness cannot be verified.",
    });
  } else if (!contractBlocker) {
    try {
      readiness = evaluateReadiness(setupOverview, {
        expectedIndustry: config?.businessType,
        requiredChannels,
      });
      for (const item of readiness.blocking || []) {
        const classification = classifyReadinessBlocker(item, readiness, requiredChannels);
        if (classification.kind === "ignore") continue;
        const classified = classification.channels.length
          ? { ...item, channels: classification.channels }
          : item;
        if (classification.kind === "testing") testingRequired.push(classified);
        else hardBlockers.push(classified);
      }
      warnings.push(...(readiness.warnings || []));
    } catch (err) {
      hardBlockers.push({
        key: err?.code || "go_live_evaluation",
        status: "error",
        summary: err?.message || "Go-live readiness could not be evaluated.",
      });
    }
  }

  const blockerItems = uniqueIssues(hardBlockers)
    .map((item) => decorateIssue(item, "blocker", requiredChannels));
  const testingItems = uniqueIssues(testingRequired)
    .map((item) => decorateIssue(item, "testing", requiredChannels));
  const warningItems = uniqueIssues(warnings)
    .map((item) => decorateIssue(item, "warning", requiredChannels));
  const channels = !contractBlocker && readiness
    ? requiredChannels.map((channel) => buildChannelSummary(channel, readiness, blockerItems, testingItems))
    : requiredChannels.map((channel) => ({
        channel,
        label: channelLabel(channel),
        purchased: true,
        configured: false,
        setupReady: false,
        runtimeReady: false,
        inboundVerified: false,
        aiReplyVerified: false,
        ready: false,
        verificationState: "blocked",
        latestCustomerInboundAt: null,
        lastVerifiedRoundTripInboundAt: null,
        lastVerifiedAutomatedReplyAt: null,
        lastReadinessDeliveryFailureAt: null,
        checks: [],
        blockers: [],
        testingRequired: [],
      }));

  const channelKeys = new Set(Object.values(CHANNEL_CHECK_KEYS).flat());
  const systemBlockers = readiness
    ? blockerItems.filter((item) => {
        if (["business_profile", "business_setup", "purchased_channels"].includes(item.key)) return false;
        if (channelKeys.has(item.key)) return false;
        return !requiredChannels.some((channel) => item.key?.startsWith(`${channel}_`));
      })
    : blockerItems.filter((item) => !["business_setup", "purchased_channels"].includes(item.key));

  const status = blockerItems.length > 0
    ? "blocked"
    : testingItems.length > 0
      ? "needs_testing"
      : warningItems.length > 0
        ? "ready_with_warnings"
        : "ready";
  const ready = ["ready", "ready_with_warnings"].includes(status);
  const profileReady = readiness?.businessProfile?.status === "ready";

  return {
    schemaVersion: GO_LIVE_SCHEMA_VERSION,
    status,
    ready,
    decision: {
      status,
      handoverAllowed: ready,
    },
    checkedAt: setupOverview?.checkedAt || new Date().toISOString(),
    lastTechnicalRunAt: setupOverview?.lastRunAt || null,
    businessType: config?.businessType || null,
    businessName: config?.businessName || config?.clinicName || null,
    businessSetup,
    businessProfile: readiness?.businessProfile || setupOverview?.businessProfile || null,
    profileAlignment: {
      ready: profileReady,
      expectedIndustry: readiness?.businessProfile?.expectedIndustry || config?.businessType || null,
      actualIndustry: readiness?.businessProfile?.actualIndustry || setupOverview?.businessProfile?.businessType || null,
      summary: readiness?.businessProfile?.summary || "Business-profile alignment has not been verified yet.",
    },
    channelContract: {
      configured: contract?.configured === true,
      channels: requiredChannels,
      error: contract?.error || null,
      source: contract?.source || null,
    },
    system: {
      ready: systemBlockers.length === 0 && Boolean(readiness),
      applicationReady: readiness?.summary?.applicationReady || 0,
      applicationTotal: readiness?.summary?.applicationTotal || 0,
      health: readiness?.operationalHealth || setupOverview?.systemHealth || null,
      blockers: systemBlockers,
    },
    channels,
    blockers: blockerItems,
    testingRequired: testingItems,
    warnings: warningItems,
    summary: {
      blockers: blockerItems.length,
      testingRequired: testingItems.length,
      warnings: warningItems.length,
      purchasedChannels: requiredChannels.length,
      channelsReady: channels.filter((item) => item.ready).length,
    },
  };
}

module.exports = {
  CHANNEL_LABELS,
  GO_LIVE_SCHEMA_VERSION,
  blockerBelongsToChannel,
  buildChannelSummary,
  channelsForIssue,
  classifyReadinessBlocker,
  evaluateGoLiveGate,
  hasStableRoundTrip,
  uniqueIssues,
};
'''
write("src/services/goLiveGateService.js", go_live_service)

# 5) Go Live route uses shared service and exposes a testable router factory.
go_live_route = r'''const express = require("express");
const configRepo = require("../db/configRepo");
const { evaluateClientSetup } = require("../services/clientSetupService");
const { evaluateGoLiveGate } = require("../services/goLiveGateService");
const {
  decorateOverview,
  setupStatus,
} = require("../services/setupStatusOverviewService");

function requireAdministrator(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Only administrators can view go-live readiness." });
  }
  next();
}

function requestBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

async function loadGoLiveGate({ runChecks = false, baseUrl } = {}) {
  const rawOverview = runChecks
    ? await setupStatus.runAll({ requestBaseUrl: baseUrl })
    : await setupStatus.getOverview({ requestBaseUrl: baseUrl });
  const setupOverview = await decorateOverview(rawOverview);
  const config = configRepo.getConfig();
  const clientSetup = evaluateClientSetup(config);

  return evaluateGoLiveGate({
    config,
    clientSetup,
    setupOverview,
  });
}

function createGoLiveRouter({ loadGate = loadGoLiveGate } = {}) {
  const router = express.Router();
  router.use(requireAdministrator);

  router.get("/", async (req, res) => {
    try {
      return res.json(await loadGate({ baseUrl: requestBaseUrl(req), runChecks: false }));
    } catch (err) {
      console.error("Failed to load go-live readiness:", err);
      return res.status(500).json({
        error: "Something went wrong loading go-live readiness.",
        code: "GO_LIVE_GATE_LOAD_FAILED",
      });
    }
  });

  router.post("/run", async (req, res) => {
    try {
      return res.json(await loadGate({
        runChecks: true,
        baseUrl: requestBaseUrl(req),
      }));
    } catch (err) {
      console.error("Failed to run go-live readiness checks:", err);
      return res.status(500).json({
        error: "Something went wrong running go-live readiness checks.",
        code: "GO_LIVE_GATE_RUN_FAILED",
      });
    }
  });

  return router;
}

const router = createGoLiveRouter();

module.exports = router;
module.exports.createGoLiveRouter = createGoLiveRouter;
module.exports.loadGoLiveGate = loadGoLiveGate;
module.exports.requestBaseUrl = requestBaseUrl;
module.exports.requireAdministrator = requireAdministrator;
module.exports.setupStatus = setupStatus;
'''
write("src/routes/goLive.js", go_live_route)

# 6) UI: actionable issues, explicit business-profile alignment and a three-step live-test guide.
go_live_ui = read("portal-frontend/src/pages/GoLive.jsx")
go_live_ui = go_live_ui.replace(
    'function IssueList({ title, items, tone = "warning" }) {',
    'function IssueList({ title, items, tone = "warning", onNavigate }) {'
)
go_live_ui = go_live_ui.replace(
    '''          <div key={`${item.key || "issue"}-${index}`} className="rounded-xl bg-white px-3.5 py-3 text-xs leading-5 shadow-sm">
            {item.summary || "Readiness item needs review."}
          </div>''',
    '''          <div key={`${item.key || "issue"}-${index}`} className="rounded-xl bg-white px-3.5 py-3 text-xs leading-5 shadow-sm">
            <p>{item.summary || "Readiness item needs review."}</p>
            {item.action && <p className="mt-1.5 font-medium text-[var(--color-text)]">Next: {item.action}</p>}
            {item.remediationRoute && onNavigate && (
              <button type="button" onClick={() => onNavigate(item.remediationRoute)} className="mt-2 h-8 rounded-lg border border-[var(--color-border)] px-2.5 text-[11px] font-semibold">
                Open {item.category === "business_setup" ? "Client Setup" : "Setup Status"}
              </button>
            )}
          </div>'''
)
go_live_ui = go_live_ui.replace(
    '''        <Signal ok={channel.inboundVerified} label="Real customer inbound" detail={channel.lastInboundAt ? `Observed ${formatTime(channel.lastInboundAt)}` : "No real inbound message has been verified yet."} />
        <Signal ok={channel.aiReplyVerified} label="Verified AI reply" detail={channel.lastVerifiedAutomatedReplyAt ? `Provider accepted ${formatTime(channel.lastVerifiedAutomatedReplyAt)}` : "No provider-accepted normal AI reply to the latest inbound has been verified yet."} />
      </div>
    </article>''',
    '''        <Signal ok={channel.inboundVerified} label="Verified customer inbound" detail={channel.lastVerifiedRoundTripInboundAt ? `Round-trip proof started ${formatTime(channel.lastVerifiedRoundTripInboundAt)}` : "No successful real-customer round trip has been verified yet."} />
        <Signal ok={channel.aiReplyVerified} label="Verified AI reply" detail={channel.lastVerifiedAutomatedReplyAt ? `Provider accepted ${formatTime(channel.lastVerifiedAutomatedReplyAt)}` : "No provider-accepted normal AI reply has completed a verified round trip yet."} />
      </div>
      {!channel.blockers?.length && channel.testingRequired?.length > 0 && (
        <div className="mt-3 rounded-xl bg-[var(--color-accent-light)]/45 px-3.5 py-3 text-[11px] leading-5">
          <p className="font-bold">How to complete the live test</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[var(--color-text-muted)]">
            <li>Send a genuine customer message on {channel.label}.</li>
            <li>Allow the normal AI reply path to respond successfully.</li>
            <li>Return here and run go-live checks again.</li>
          </ol>
        </div>
      )}
    </article>'''
)
# Add profile alignment inside the Business setup card before the incomplete sections.
anchor = '''            </div>
            {incompleteBusinessItems.length > 0 ? ('''
profile_signal = '''            </div>
            <div className="mt-4">
              <Signal
                ok={data.profileAlignment?.ready}
                label="Business profile alignment"
                detail={data.profileAlignment?.summary || "Business-profile alignment has not been verified yet."}
              />
            </div>
            {incompleteBusinessItems.length > 0 ? ('''
if anchor not in go_live_ui:
    raise SystemExit("GoLive.jsx: business profile insertion anchor missing")
go_live_ui = go_live_ui.replace(anchor, profile_signal, 1)
# Issue lists become actionable.
go_live_ui = go_live_ui.replace(
    '<IssueList title="Blocking issues" items={data.blockers} tone="danger" />',
    '<IssueList title="Blocking issues" items={data.blockers} tone="danger" onNavigate={navigate} />'
)
go_live_ui = go_live_ui.replace(
    '<IssueList title="Live testing required" items={data.testingRequired} />',
    '<IssueList title="Live testing required" items={data.testingRequired} onNavigate={navigate} />'
)
go_live_ui = go_live_ui.replace(
    '<IssueList title="Warnings to review" items={data.warnings} />',
    '<IssueList title="Warnings to review" items={data.warnings} onNavigate={navigate} />'
)
write("portal-frontend/src/pages/GoLive.jsx", go_live_ui)

# 7) Fix the two small cleanup items from review.
replace_once(
    "src/services/clientSetupService.js",
    '''  const clinicBranches = Array.isArray(config.branches) ? config.branches : [];
const clinicBranchMissingAddress = config?.businessType === "aesthetic_clinic"
  && clinicBranches.some((branch) => text(branch?.name) && !text(branch?.address));
const locationMissing = locationRequired
  ? [
      ...(!branchesConfigured ? ["Add at least one branch"] : []),
      ...(clinicBranchMissingAddress ? ["Add an address for every clinic branch"] : []),
    ]
  : [];''',
    '''  const clinicBranches = Array.isArray(config.branches) ? config.branches : [];
  const clinicBranchMissingAddress = config?.businessType === "aesthetic_clinic"
    && clinicBranches.some((branch) => text(branch?.name) && !text(branch?.address));
  const locationMissing = locationRequired
    ? [
        ...(!branchesConfigured ? ["Add at least one branch"] : []),
        ...(clinicBranchMissingAddress ? ["Add an address for every clinic branch"] : []),
      ]
    : [];'''
)
api_path = ROOT / "portal-frontend/src/api.js"
api_text = api_path.read_text()
api_path.write_text(api_text.rstrip("\n") + "\n")

# 8) Tests: stable proof rows/SQL, structured classification, multi-channel scenarios,
# shared Meta webhook behavior, schema metadata, and behavioral admin routing.
for path in ["test/systemHealthRepo.test.js", "test/systemHealthRoundTripCorrelation.test.js"]:
    text = read(path)
    text = text.replace(
        'last_verified_ai_reply_at: new Date("2026-09-05T00:00:05Z"),',
        'last_verified_round_trip_contact_id: 10,\n              last_verified_round_trip_inbound_message_id: 100,\n              last_verified_round_trip_inbound_at: new Date("2026-09-05T00:00:00Z"),\n              last_verified_ai_reply_at: new Date("2026-09-05T00:00:05Z"),'
    )
    text = text.replace(
        'last_verified_ai_reply_at: "2026-09-08T10:00:02.000Z",',
        'last_verified_round_trip_contact_id: 11,\n              last_verified_round_trip_inbound_message_id: 101,\n              last_verified_round_trip_inbound_at: "2026-09-08T10:00:00.000Z",\n              last_verified_ai_reply_at: "2026-09-08T10:00:02.000Z",'
    )
    text = text.replace(
        'last_verified_ai_reply_at: "2026-09-08T10:00:07.000Z",',
        'last_verified_round_trip_contact_id: 33,\n              last_verified_round_trip_inbound_message_id: 303,\n              last_verified_round_trip_inbound_at: "2026-09-08T10:00:04.000Z",\n              last_verified_ai_reply_at: "2026-09-08T10:00:07.000Z",'
    )
    # Explicit null stable-proof fields for rows without verified round trip.
    text = text.replace(
        'last_verified_ai_reply_at: null,\n              last_ai_reply_failure_at:',
        'last_verified_round_trip_contact_id: null,\n              last_verified_round_trip_inbound_message_id: null,\n              last_verified_round_trip_inbound_at: null,\n              last_verified_ai_reply_at: null,\n              last_ai_reply_failure_at:'
    )
    write(path, text)

# Update systemHealthRepo-specific assertions.
replace_once(
    "test/systemHealthRepo.test.js",
    '''  assert.equal(whatsapp.lastVerifiedAutomatedReplyAt.toISOString(), "2026-09-05T00:00:05.000Z");
  assert.equal(whatsapp.roundTripCorrelated, true);''',
    '''  assert.equal(whatsapp.lastVerifiedRoundTripInboundAt.toISOString(), "2026-09-05T00:00:00.000Z");
  assert.equal(whatsapp.lastVerifiedAutomatedReplyAt.toISOString(), "2026-09-05T00:00:05.000Z");
  assert.equal(whatsapp.roundTripCorrelated, true);'''
)
replace_once(
    "test/systemHealthRoundTripCorrelation.test.js",
    '''  assert.equal(whatsapp.lastVerifiedAutomatedReplyAt, "2026-09-08T10:00:02.000Z");
  assert.equal(whatsapp.roundTripCorrelated, true);''',
    '''  assert.equal(whatsapp.lastVerifiedRoundTripInboundAt, "2026-09-08T10:00:00.000Z");
  assert.equal(whatsapp.lastVerifiedAutomatedReplyAt, "2026-09-08T10:00:02.000Z");
  assert.equal(whatsapp.roundTripCorrelated, true);'''
)
replace_once(
    "test/systemHealthRoundTripCorrelation.test.js",
    '''  assert.match(readinessSql, /e\.message_id = reply\.id/);
  assert.match(readinessSql, /e\.contact_id = li\.contact_id/);
  assert.match(readinessSql, /e\.channel = li\.channel/);
  assert.match(readinessSql, /e\.origin = 'ai_reply'/);
  assert.match(readinessSql, /e\.accepted = true/);''',
    '''  assert.match(readinessSql, /e\.message_id = reply\.id/);
  assert.match(readinessSql, /reply\.contact_id = e\.contact_id/);
  assert.match(readinessSql, /c\.channel = e\.channel/);
  assert.match(readinessSql, /inbound_message\.created_at < reply\.created_at/);
  assert.match(readinessSql, /ROW_NUMBER\(\) OVER/);
  assert.match(readinessSql, /e\.origin = 'ai_reply'/);
  assert.match(readinessSql, /e\.accepted = true/);'''
)

# Ensure setup-status reason code is preserved by readinessItem.
readiness_test = read("test/readinessVerifier.test.js")
if 'reason: "live_evidence_pending"' not in readiness_test:
    readiness_test += r'''

test("readiness preserves structured Setup Status reason codes", () => {
  const overview = fullyReadyOverview();
  overview.checks = overview.checks.map((item) =>
    item.key === "whatsapp_webhook"
      ? { ...item, status: "warning", configured: true, reason: "live_evidence_pending" }
      : item
  );
  const report = evaluateReadiness(overview, {
    expectedIndustry: "aesthetic_clinic",
    requiredChannels: ["whatsapp"],
  });
  const webhook = report.channelChecks.find((item) => item.key === "whatsapp_webhook");
  assert.equal(webhook.reason, "live_evidence_pending");
});
'''
write("test/readinessVerifier.test.js", readiness_test)

# Update Go Live helper proof fields and reason code.
go_test = read("test/goLiveGate.test.js")
go_test = go_test.replace(
    '''    lastInboundAt: "2026-09-09T10:00:00.000Z",
    lastSuccessfulOutboundAt: "2026-09-09T10:00:04.000Z",
    lastVerifiedAutomatedReplyAt: "2026-09-09T10:00:03.000Z",''',
    '''    lastInboundAt: "2026-09-09T10:00:00.000Z",
    lastSuccessfulOutboundAt: "2026-09-09T10:00:04.000Z",
    lastVerifiedRoundTripInboundAt: "2026-09-09T10:00:00.000Z",
    lastVerifiedAutomatedReplyAt: "2026-09-09T10:00:03.000Z",'''
)
go_test = go_test.replace(
    '''          status: "warning",
          summary: "Configured. Waiting for the first valid signed webhook from Meta.",''',
    '''          status: "warning",
          reason: "live_evidence_pending",
          summary: "Configured. Waiting for the first valid signed webhook from Meta.",'''
)
go_test = go_test.replace(
    '''          lastInboundAt: null,
          lastVerifiedAutomatedReplyAt: null,
          lastReadinessDeliveryFailureAt: null,''',
    '''          lastInboundAt: null,
          lastVerifiedRoundTripInboundAt: null,
          lastVerifiedAutomatedReplyAt: null,
          lastReadinessDeliveryFailureAt: null,'''
)
# The old stale-latest-inbound expectation now verifies preserved proof instead of invalidating it.
old_stale_test = r'''test("latest inbound without a newer verified AI reply is needs_testing", () => {
  const overview = setupOverview();
  overview.systemHealth.messaging = overview.systemHealth.messaging.map((item) =>
    item.channel === "whatsapp"
      ? {
          ...item,
          lastInboundAt: "2026-09-09T10:05:00.000Z",
          lastVerifiedAutomatedReplyAt: "2026-09-09T10:04:59.000Z",
        }
      : item
  );

  const gate = evaluate({ overview });

  assert.equal(gate.status, "needs_testing");
  assert.equal(gate.testingRequired.some((item) => item.key === "whatsapp_round_trip_outbound"), true);
  assert.equal(gate.channels[0].aiReplyVerified, false);
});'''
new_stale_test = r'''test("newer customer inbound does not erase an already verified round trip", () => {
  const overview = setupOverview();
  overview.systemHealth.messaging = overview.systemHealth.messaging.map((item) =>
    item.channel === "whatsapp"
      ? {
          ...item,
          // This can be a later human-takeover conversation. Historical proof
          // remains valid while current runtime health stays healthy.
          lastInboundAt: "2026-09-09T10:05:00.000Z",
          lastVerifiedRoundTripInboundAt: "2026-09-09T10:00:00.000Z",
          lastVerifiedAutomatedReplyAt: "2026-09-09T10:00:03.000Z",
        }
      : item
  );

  const gate = evaluate({ overview });

  assert.equal(gate.status, "ready");
  assert.equal(gate.testingRequired.some((item) => item.key === "whatsapp_round_trip_outbound"), false);
  assert.equal(gate.channels[0].aiReplyVerified, true);
  assert.equal(gate.channels[0].latestCustomerInboundAt, "2026-09-09T10:05:00.000Z");
  assert.equal(gate.channels[0].lastVerifiedRoundTripInboundAt, "2026-09-09T10:00:00.000Z");
});'''
if old_stale_test not in go_test:
    raise SystemExit("goLiveGate.test.js: old stale test not found")
go_test = go_test.replace(old_stale_test, new_stale_test, 1)
# Add schema/issue metadata plus multi-channel tests.
go_test += r'''

test("gate exposes a stable machine-readable v1 contract", () => {
  const gate = evaluate();
  assert.equal(gate.schemaVersion, 1);
  assert.deepEqual(gate.decision, { status: "ready", handoverAllowed: true });
  assert.equal(gate.profileAlignment.ready, true);
});

test("structured testing issues do not depend on human-readable summary text", () => {
  const overview = setupOverview();
  overview.checks = overview.checks.map((item) =>
    item.key === "whatsapp_webhook"
      ? {
          ...item,
          configured: true,
          status: "warning",
          reason: "live_evidence_pending",
          summary: "Copy can change without changing behavior.",
        }
      : item
  );
  overview.systemHealth.messaging = overview.systemHealth.messaging.map((item) =>
    item.channel === "whatsapp"
      ? {
          ...item,
          lastVerifiedRoundTripInboundAt: null,
          lastVerifiedAutomatedReplyAt: null,
        }
      : item
  );

  const gate = evaluate({ overview });
  const issue = gate.testingRequired.find((item) => item.key === "whatsapp_webhook");
  assert.equal(gate.status, "needs_testing");
  assert.equal(issue.category, "live_test");
  assert.equal(issue.channel, "whatsapp");
  assert.equal(issue.severity, "action_required");
  assert.match(issue.action, /genuine customer/i);
});

test("whatsapp and instagram both must pass when both were purchased", () => {
  const overview = setupOverview();
  overview.checks = overview.checks.map((item) => {
    if (item.key === "instagram" || item.key === "meta_webhook") {
      return { ...item, configured: true, status: "ready", summary: `${item.key} is ready` };
    }
    return item;
  });
  overview.systemHealth.messaging = overview.systemHealth.messaging.map((item) =>
    item.channel === "instagram" ? healthyMessaging("instagram") : item
  );

  const gate = evaluate({ completion: clientSetup(["whatsapp", "instagram"]), overview });
  assert.equal(gate.status, "ready");
  assert.equal(gate.channels.length, 2);
  assert.equal(gate.channels.every((item) => item.ready), true);
});

test("one purchased channel can be ready while another still needs live testing", () => {
  const overview = setupOverview();
  overview.checks = overview.checks.map((item) => {
    if (item.key === "instagram") {
      return { ...item, configured: true, status: "warning", reason: "live_evidence_pending", summary: "Awaiting proof." };
    }
    if (item.key === "meta_webhook") {
      return { ...item, configured: true, status: "warning", reason: "live_evidence_pending", summary: "Awaiting proof." };
    }
    return item;
  });
  overview.systemHealth.messaging = overview.systemHealth.messaging.map((item) =>
    item.channel === "instagram"
      ? {
          ...healthyMessaging("instagram"),
          lastInboundAt: null,
          lastVerifiedRoundTripInboundAt: null,
          lastVerifiedAutomatedReplyAt: null,
        }
      : item
  );

  const gate = evaluate({ completion: clientSetup(["whatsapp", "instagram"]), overview });
  const whatsapp = gate.channels.find((item) => item.channel === "whatsapp");
  const instagram = gate.channels.find((item) => item.channel === "instagram");
  assert.equal(gate.status, "needs_testing");
  assert.equal(whatsapp.ready, true);
  assert.equal(instagram.ready, false);
  assert.equal(instagram.testingRequired.length > 0, true);
});

test("shared Meta webhook hard failure blocks both purchased social channels without duplicate global issues", () => {
  const overview = setupOverview();
  overview.checks = overview.checks.map((item) => {
    if (["facebook", "instagram"].includes(item.key)) {
      return { ...item, configured: true, status: "ready", summary: `${item.key} is ready` };
    }
    if (item.key === "meta_webhook") {
      return { ...item, configured: true, status: "error", summary: "Meta webhook secret check failed." };
    }
    return item;
  });
  overview.systemHealth.messaging = overview.systemHealth.messaging.map((item) =>
    ["facebook", "instagram"].includes(item.channel) ? healthyMessaging(item.channel) : item
  );

  const gate = evaluate({ completion: clientSetup(["facebook", "instagram"]), overview });
  assert.equal(gate.status, "blocked");
  assert.equal(gate.blockers.filter((item) => item.key === "meta_webhook").length, 1);
  assert.deepEqual(gate.blockers.find((item) => item.key === "meta_webhook").channels.sort(), ["facebook", "instagram"]);
  assert.equal(gate.channels.find((item) => item.channel === "facebook").ready, false);
  assert.equal(gate.channels.find((item) => item.channel === "instagram").ready, false);
});
'''
write("test/goLiveGate.test.js", go_test)

# Architecture test now enforces the shared-service boundary and machine/UI additions.
arch = read("test/goLiveGateArchitecture.test.js")
arch = arch.replace(
    '''  assert.match(route, /setupStatus\.getOverview/);
  assert.match(route, /setupStatus\.runAll/);''',
    '''  assert.match(route, /setupStatus\.getOverview/);
  assert.match(route, /setupStatus\.runAll/);
  assert.match(route, /setupStatusOverviewService/);
  assert.doesNotMatch(route, /require\("\.\/setupStatus"\)/);'''
)
arch += r'''

test("go-live page exposes actionable remediation and explicit profile alignment", () => {
  const page = source("portal-frontend/src/pages/GoLive.jsx");
  const service = source("src/services/goLiveGateService.js");

  assert.match(page, /Business profile alignment/);
  assert.match(page, /How to complete the live test/);
  assert.match(page, /item\.remediationRoute/);
  assert.match(service, /schemaVersion: GO_LIVE_SCHEMA_VERSION/);
  assert.match(service, /reason === "live_evidence_pending"/);
  assert.doesNotMatch(service, /PASSIVE_CHANNEL_WARNING/);
});
'''
write("test/goLiveGateArchitecture.test.js", arch)

behavior_test = r'''const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createGoLiveRouter } = require("../src/routes/goLive");

async function withServer(role, loadGate, callback) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = role ? { role } : null;
    next();
  });
  app.use("/api/go-live", createGoLiveRouter({ loadGate }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("go-live route rejects non-admin users with 403", async () => {
  let calls = 0;
  await withServer("staff", async () => {
    calls += 1;
    return { schemaVersion: 1, status: "ready", ready: true };
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/go-live`);
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /administrators/i);
  });
  assert.equal(calls, 0);
});

test("admin GET and POST execute the expected safe gate modes", async () => {
  const modes = [];
  await withServer("admin", async ({ runChecks, baseUrl }) => {
    modes.push({ runChecks, baseUrl });
    return {
      schemaVersion: 1,
      status: "ready",
      ready: true,
      decision: { status: "ready", handoverAllowed: true },
    };
  }, async (baseUrl) => {
    const getResponse = await fetch(`${baseUrl}/api/go-live`);
    assert.equal(getResponse.status, 200);
    assert.equal((await getResponse.json()).schemaVersion, 1);

    const postResponse = await fetch(`${baseUrl}/api/go-live/run`, { method: "POST" });
    assert.equal(postResponse.status, 200);
    assert.equal((await postResponse.json()).decision.handoverAllowed, true);
  });

  assert.deepEqual(modes.map((item) => item.runChecks), [false, true]);
  assert.equal(modes.every((item) => /^http:\/\/127\.0\.0\.1:\d+$/.test(item.baseUrl)), true);
});
'''
write("test/goLiveRouteBehavior.test.js", behavior_test)

# Ensure source-based setup tests can still import the same helpers after extraction.
# Existing route exports remain intentionally unchanged.

print("PR116 hardening patches applied")
