const fs = require("fs");

function read(path) {
  return fs.readFileSync(path, "utf8");
}

function write(path, content) {
  fs.writeFileSync(path, content);
}

function replaceOnce(content, from, to, label) {
  const index = content.indexOf(from);
  if (index < 0) throw new Error(`Patch target not found: ${label}`);
  if (content.indexOf(from, index + from.length) >= 0) {
    throw new Error(`Patch target is ambiguous: ${label}`);
  }
  return content.slice(0, index) + to + content.slice(index + from.length);
}

function replaceRegex(content, regex, to, label) {
  if (!regex.test(content)) throw new Error(`Patch regex not found: ${label}`);
  regex.lastIndex = 0;
  return content.replace(regex, to);
}

function patchWhatsApp() {
  const path = "src/services/whatsappService.js";
  let content = read(path);
  if (!content.includes("normalizeWhatsAppReferral")) {
    content = replaceOnce(
      content,
      'const GRAPH_API_VERSION = "v26.0";\n',
      'const GRAPH_API_VERSION = "v26.0";\nconst { normalizeWhatsAppReferral } = require("../utils/leadAttribution");\n',
      "WhatsApp attribution import"
    );
  }

  const replacement = `function parseIncomingMessages(body) {
  try {
    const parsed = [];

    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        const value = change?.value;
        const contacts = value?.contacts || [];

        for (const message of value?.messages || []) {
          if (!message?.id || !message?.from) continue;
          const whatsappContact = contacts.find((contact) => contact.wa_id === message.from);
          const profileName = whatsappContact?.profile?.name?.trim() || null;
          const attribution = message.referral
            ? normalizeWhatsAppReferral(message.referral)
            : null;
          const base = {
            id: message.id,
            from: message.from,
            profileName,
            attribution,
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
}`;

  content = replaceRegex(
    content,
    /function parseIncomingMessages\(body\) \{[\s\S]*?\n\}\n\n\/\*\*\n \* Pulls out every delivery-status/,
    `${replacement}\n\n/**\n * Pulls out every delivery-status`,
    "WhatsApp parseIncomingMessages"
  );
  write(path, content);
}

function patchMetaMessaging() {
  const path = "src/services/metaMessagingService.js";
  let content = read(path);
  if (!content.includes("normalizeSocialReferral")) {
    content = replaceOnce(
      content,
      'const PROFILE_FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;\n',
      'const PROFILE_FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;\nconst { normalizeSocialReferral } = require("../utils/leadAttribution");\n',
      "Meta attribution import"
    );
  }

  const replacement = `function parseIncomingMessages(body) {
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
            id: \`referral:\${entry?.id || "page"}:\${event?.timestamp || "unknown"}:\${senderId}\`,
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
        attribution,
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
}`;

  content = replaceRegex(
    content,
    /function parseIncomingMessages\(body\) \{[\s\S]*?\n\}\n\nasync function downloadMedia/,
    `${replacement}\n\nasync function downloadMedia`,
    "Meta parseIncomingMessages"
  );
  write(path, content);
}

function patchLeadDrawer() {
  const path = "portal-frontend/src/components/pipeline/LeadDrawer.jsx";
  let content = read(path);
  if (!content.includes('import LeadAttributionPanel from "./LeadAttributionPanel";')) {
    content = replaceOnce(
      content,
      'import ContactAvatar from "../ContactAvatar";\n',
      'import ContactAvatar from "../ContactAvatar";\nimport LeadAttributionPanel from "./LeadAttributionPanel";\n',
      "LeadDrawer attribution import"
    );
  }
  if (!content.includes("<LeadAttributionPanel lead={lead} />")) {
    content = replaceOnce(
      content,
      '          <form onSubmit={handleSave} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">',
      '          <LeadAttributionPanel lead={lead} />\n\n          <form onSubmit={handleSave} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">',
      "LeadDrawer attribution panel"
    );
  }
  write(path, content);
}

function patchPipelinePage() {
  const path = "portal-frontend/src/pages/Pipeline.jsx";
  let content = read(path);
  if (!content.includes('sourceLabel } from "../components/pipeline/LeadAttributionPanel"')) {
    content = replaceOnce(
      content,
      'import { formatMoney, isNoReply, isOverdue } from "../components/pipeline/pipelineUtils";\n',
      'import { formatMoney, isNoReply, isOverdue } from "../components/pipeline/pipelineUtils";\nimport { sourceLabel } from "../components/pipeline/LeadAttributionPanel";\n',
      "Pipeline source label import"
    );
  }

  if (!content.includes("const [sourceFilter, setSourceFilter]")) {
    content = replaceOnce(
      content,
      '  const [branchFilter, setBranchFilter] = useState(() => parameterOrNull(searchParams, "branch") || "all");\n',
      '  const [branchFilter, setBranchFilter] = useState(() => parameterOrNull(searchParams, "branch") || "all");\n  const [sourceFilter, setSourceFilter] = useState(() => parameterOrNull(searchParams, "source_filter") || "all");\n',
      "Pipeline source filter state"
    );
  }

  content = replaceOnce(
    content,
    '    setBranchFilter(requestedBranch);\n    setCategoryFilter(CATEGORY_KEYS.has(requestedCategory) ? requestedCategory : "all");\n',
    '    setBranchFilter(requestedBranch);\n    setSourceFilter(parameterOrNull(searchParams, "source_filter") || "all");\n    setCategoryFilter(CATEGORY_KEYS.has(requestedCategory) ? requestedCategory : "all");\n',
    "Pipeline source filter URL sync"
  );

  const oldDrilldown = `  const drilldownLeads = useMemo(() => {
    return analyticsBaseLeads.filter((lead) => {
      if (branchFilter === "unassigned" && lead.branch_name) return false;
      if (branchFilter !== "all" && branchFilter !== "unassigned" && lead.branch_name !== branchFilter) return false;
      return true;
    });
  }, [analyticsBaseLeads, branchFilter]);`;
  const newDrilldown = `  const sourceFilteredLeads = useMemo(() => {
    if (sourceFilter === "all") return analyticsBaseLeads;
    return analyticsBaseLeads.filter(
      (lead) => (lead.attribution?.source || lead.source) === sourceFilter
    );
  }, [analyticsBaseLeads, sourceFilter]);

  const drilldownLeads = useMemo(() => {
    return sourceFilteredLeads.filter((lead) => {
      if (branchFilter === "unassigned" && lead.branch_name) return false;
      if (branchFilter !== "all" && branchFilter !== "unassigned" && lead.branch_name !== branchFilter) return false;
      return true;
    });
  }, [sourceFilteredLeads, branchFilter]);`;
  if (!content.includes("const sourceFilteredLeads = useMemo")) {
    content = replaceOnce(content, oldDrilldown, newDrilldown, "Pipeline source filtering");
  }

  content = replaceOnce(
    content,
    '          lead.source,\n          lead.campaign_name,\n',
    '          lead.source,\n          lead.attribution?.source,\n          lead.attribution?.headline,\n          lead.attribution?.meta_ad_id,\n          lead.campaign_name,\n',
    "Pipeline attribution search haystack"
  );

  content = replaceOnce(
    content,
    '  const branchCardBase = hasAnalyticsDrilldown ? analyticsBaseLeads : leads;\n',
    '  const branchCardBase = sourceFilter !== "all" || hasAnalyticsDrilldown ? sourceFilteredLeads : leads;\n',
    "Pipeline branch cards respect source"
  );

  if (!content.includes("function selectSource(value)")) {
    content = replaceOnce(
      content,
      '  function selectCategory(value) {\n    setCategoryFilter(value);\n    updateParam("category", value);\n  }\n',
      '  function selectCategory(value) {\n    setCategoryFilter(value);\n    updateParam("category", value);\n  }\n\n  function selectSource(value) {\n    setSourceFilter(value);\n    updateParam("source_filter", value);\n  }\n',
      "Pipeline selectSource"
    );
  }

  const oldSearchControls = `          <span className="hidden shrink-0 text-[11px] font-medium text-[var(--color-text-muted)] md:block">{filteredLeads.length} shown</span>`;
  const newSearchControls = `          <select
            value={sourceFilter}
            onChange={(event) => selectSource(event.target.value)}
            aria-label="Filter by lead source"
            className="h-11 max-w-[13rem] shrink-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-xs font-semibold text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/15"
          >
            <option value="all">All sources</option>
            {(data?.sources || []).map((source) => (
              <option key={source} value={source}>{sourceLabel(source)}</option>
            ))}
          </select>
          <span className="hidden shrink-0 text-[11px] font-medium text-[var(--color-text-muted)] md:block">{filteredLeads.length} shown</span>`;
  if (!content.includes('aria-label="Filter by lead source"')) {
    content = replaceOnce(content, oldSearchControls, newSearchControls, "Pipeline source selector");
  }

  write(path, content);
}

patchWhatsApp();
patchMetaMessaging();
patchLeadDrawer();
patchPipelinePage();
console.log("Lead attribution patch applied.");
