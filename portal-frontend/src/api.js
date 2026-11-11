const BASE = "/api";

// Only one volatile, per-tab snapshot. Do not persist patient summaries in
// localStorage, sessionStorage, service workers or the HTTP disk cache.
let inboxSnapshot = null;
let inboxSnapshotEtag = null;
let inboxSnapshotRevisionProof = null;
function clearInboxSnapshotCache() {
  inboxSnapshot = null;
  inboxSnapshotEtag = null;
  inboxSnapshotRevisionProof = null;
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (!res.ok) {
    if (res.status === 401) clearInboxSnapshotCache();
    const body = await res.json().catch(() => ({}));
    const error = new Error(body.error || `Request failed (${res.status})`);
    error.status = res.status;
    error.code = body.code || null;
    error.policyBlocked = body.policyBlocked === true;
    error.diagnosticStatus = body.diagnosticStatus || null;
    // A changed WhatsApp billing review must reach the template picker without
    // destroying the selected media, template variables, or user draft.
    error.billingAdvisory = body.billingAdvisory || null;
    throw error;
  }

  return res.json();
}

async function listInboxConversations(refreshReason = "other") {
  const headers = {
    "Content-Type": "application/json",
    "X-Inbox-Refresh-Reason": refreshReason,
    ...(inboxSnapshot && inboxSnapshotEtag
      ? { "If-None-Match": inboxSnapshotEtag } : {}),
    ...(inboxSnapshot && inboxSnapshotEtag && inboxSnapshotRevisionProof
      ? { "X-Inbox-Revision-Proof": inboxSnapshotRevisionProof } : {}),
  };
  // Explicit conditional validation, never the browser's persistent cache.
  const res = await fetch(`${BASE}/conversations`, {
    credentials: "include", cache: "no-store", headers,
  });
  if (res.status === 304 && inboxSnapshot) {
    // A full-query 304 may supply the first usable revision proof after a
    // previous WAL-check failure. Retain it only for the same strong ETag.
    const returnedEtag = res.headers.get("etag");
    const returnedProof = res.headers.get("x-inbox-revision-proof");
    if (returnedProof && returnedEtag && returnedEtag === inboxSnapshotEtag) {
      inboxSnapshotRevisionProof = returnedProof;
    }
    // Server has freshly checked the complete payload AND current staff scope.
    return inboxSnapshot;
  }
  if (res.status === 304) {
    // Unexpected 304 after a cancelled session/cache reset. Get a fresh body.
    clearInboxSnapshotCache();
    return request("/conversations", {
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Inbox-Refresh-Reason": refreshReason },
    });
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) clearInboxSnapshotCache();
    const body = await res.json().catch(() => ({}));
    const error = new Error(body.error || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  const payload = await res.json();
  if (!Array.isArray(payload)) throw new TypeError("Invalid Inbox list response.");
  inboxSnapshot = payload;
  inboxSnapshotEtag = res.headers.get("etag");
  // Only an opaque, server-signed proof; no patient data or disk persistence.
  inboxSnapshotRevisionProof = res.headers.get("x-inbox-revision-proof");
  return payload;
}

// Paginated Inbox is intentionally not cached. Every page rechecks current
// staff access on the server. Legacy test fixtures that return arrays remain
// compatible, and production always returns page metadata and global counts.
async function listInboxConversationsPage({
  filters={},offset=0,limit=100,reason="other",
}={}) {
  const params=new URLSearchParams({
    paged:"true",offset:String(offset),limit:String(limit),
    status:filters.status||"all",channel:filters.channel||"all",
    sender:filters.sender||"all",control:filters.control||"all",
    assignment:filters.assignment||"all",replyWindow:filters.replyWindow||"all",
    query:filters.query||"",
  });
  const result=await request("/conversations?"+params.toString(),{
    cache:"no-store",
    headers:{"Content-Type":"application/json","X-Inbox-Refresh-Reason":reason},
  });
  if(Array.isArray(result)) {
    return {items:result,total:result.length,allCount:result.length,
      nextOffset:result.length,hasMore:false,statusCounts:null,
      replyWindowCounts:null,senderOptions:null,assignmentOptions:null};
  }
  if(!result || !Array.isArray(result.items) ||
      !Number.isSafeInteger(Number(result.total)) ||
      !Number.isSafeInteger(Number(result.nextOffset))) {
    throw new TypeError("Invalid paginated Inbox response");
  }
  return result;
}

async function download(path) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error = new Error(body.error || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }

  const disposition = res.headers.get("content-disposition") || "";
  const filenameMatch = disposition.match(/filename="([^"]+)"/i);
  const rowCountHeader = res.headers.get("x-export-row-count");
  const rowCount = Number.parseInt(rowCountHeader || "", 10);
  return {
    blob: await res.blob(),
    filename: filenameMatch?.[1] || "customers.csv",
    rowCount: Number.isSafeInteger(rowCount) && rowCount >= 0 ? rowCount : null,
  };
}

export const api = {
  login: async (username, password) => {
    const result = await request("/auth/login", {
      method: "POST", body: JSON.stringify({ username, password }),
    });
    clearInboxSnapshotCache();
    return result;
  },
  logout: async (pushEndpoint = null) => {
    try {
      return await request("/auth/logout", {
        method: "POST", body: JSON.stringify({ pushEndpoint }),
      });
    } finally {
      clearInboxSnapshotCache();
    }
  },
  me: () => request("/auth/me"),
  listConversations: listInboxConversations,
  listConversationsPage: listInboxConversationsPage,
  getConversationSummary: (contactId, includeArchived = false) =>
    request(`/conversations/${encodeURIComponent(contactId)}/summary${includeArchived ? "?includeArchived=true" : ""}`),
  searchConversationDirectory: (term) =>
    request(`/conversations/directory-search?q=${encodeURIComponent(term)}`),
  getSecondaryFollowUpRules: () => request("/whatsapp-secondary-followups"),
  getSecondaryMediaReview: () => request("/whatsapp-secondary-media-review"),
  saveSecondaryFollowUpRule: (slot,rule) =>
    request(`/whatsapp-secondary-followups/${slot}`, {
      method:"PUT",body:JSON.stringify(rule),
    }),
  saveSecondaryMarketingFollowUpRule: (slot,rule) =>
    request(`/whatsapp-secondary-followups/marketing/${slot}`, {
      method:"PUT",body:JSON.stringify(rule),
    }),
  resolveAiReview: (contactId, reviewId) =>
    request(`/conversations/${contactId}/reviews/${reviewId}/resolve`, { method: "PATCH" }),
  getConversationAttribution: (contactId) =>
    request(`/conversations/${contactId}/attribution`),
  getMessages: (
    contactId,
    { includeMedia = false, limit = 50, beforeId = null, afterId = null, includeMutationNotices = false } = {}
  ) => {
    const params = new URLSearchParams();
    params.set("includeMedia", includeMedia ? "true" : "false");
    params.set("limit", String(limit));
    if (beforeId != null) params.set("beforeId", String(beforeId));
    if (afterId != null) params.set("afterId", String(afterId));
    if (includeMutationNotices) params.set("includeMutationNotices", "true");
    return request(`/conversations/${contactId}/messages?${params.toString()}`);
  },
  getMessageUpdates: (contactId, messageIds) =>
    request(`/conversations/${contactId}/messages/updates?ids=${messageIds.join(",")}`),
  messageMediaUrl: (contactId, messageId) =>
    `${BASE}/conversations/${contactId}/messages/${messageId}/media`,
  sendMessage: (contactId, text, replyToMessageId = null) =>
    request(`/conversations/${contactId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        text,
        ...(replyToMessageId != null ? { replyToMessageId } : {}),
      }),
    }),
  getPromotionalBlastCampaigns: () =>
    request("/promotional-blast/campaigns", { cache: "no-store" }),
  createPromotionalBlastCampaign: payload =>
    request("/promotional-blast/campaigns", {method:"POST", body:JSON.stringify(payload)}),
  getPromotionalBlastPreview: campaignKey =>
    request(`/promotional-blast/preview?campaign=${encodeURIComponent(campaignKey)}`, { cache: "no-store" }),
  claimPromotionalBlastRecipient: (payload) =>
    request("/promotional-blast/claim", { method: "POST", body: JSON.stringify(payload) }),
  getWhatsAppTemplateFreeWindowStatus: (contactId) =>
    request(`/conversations/${contactId}/whatsapp-template-free-window`),
  listWhatsAppTemplates: (contactId, { force = false } = {}) =>
    request(
      `/conversations/${contactId}/whatsapp-templates${force ? "?refresh=true" : ""}`
    ),
  recordWhatsAppOptIn: (contactId, source, confirmed, marketingConsentConfirmed = false) =>
    request(`/conversations/${contactId}/whatsapp-opt-in`, {
      method: "POST",
      body: JSON.stringify({ source, confirmed, ...(marketingConsentConfirmed ? { marketingConsentConfirmed: true } : {}) }),
    }),
  sendWhatsAppTemplate: async (contactId, payload, mediaFile = null) => {
    if (!mediaFile) {
      return request(`/conversations/${contactId}/whatsapp-templates/send`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    const form = new FormData();
    form.append("templateName", payload.templateName);
    form.append("languageCode", payload.languageCode);
    form.append("values", JSON.stringify(payload.values || {}));
    form.append("marketingConsentConfirmed", String(payload.marketingConsentConfirmed === true));
    form.append("billingAcknowledged", String(payload.billingAcknowledged === true));
    form.append("billingReviewToken", payload.billingReviewToken || "");
    if (payload.blastCampaignKey) form.append("blastCampaignKey", payload.blastCampaignKey);
    if (payload.blastReservationToken) form.append("blastReservationToken", payload.blastReservationToken);
    form.append("media", mediaFile);
    const res = await fetch(`${BASE}/conversations/${contactId}/whatsapp-templates/send`, {
      method: "POST",
      credentials: "include",
      body: form,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const error = new Error(data.error || `Request failed (${res.status})`);
      error.status = res.status;
      error.code = data.code || null;
      error.policyBlocked = data.policyBlocked === true;
      error.billingAdvisory = data.billingAdvisory || null;
      throw error;
    }
    return res.json();
  },
  retryMessage: (contactId, messageId) =>
    request(`/conversations/${contactId}/messages/${messageId}/retry`, { method: "POST" }),
  forwardMessage: (contactId, messageId, targetContactIds, requestId = null) =>
    request(`/conversations/${contactId}/messages/${messageId}/forward`, {
      method: "POST",
      body: JSON.stringify({ targetContactIds }),
      headers: { "Content-Type": "application/json", ...(requestId ? { "X-Inbox-Request-Id": requestId } : {}) },
    }),
  getMessageDeliveryStatuses: (contactId, messageIds) =>
    request(`/conversations/${contactId}/messages/delivery-statuses`, {
      method: "POST",
      body: JSON.stringify({ messageIds }),
    }),
  sendImage: async (contactId, file, caption, replyToMessageId = null, requestId = null) => {
    const form = new FormData();
    form.append("image", file);
    if (caption) form.append("caption", caption);
    if (replyToMessageId != null) form.append("replyToMessageId", String(replyToMessageId));

    const startedAt = performance.now();
    const res = await fetch(`${BASE}/conversations/${contactId}/media`, {
      method: "POST",
      credentials: "include",
      headers: requestId ? { "X-Inbox-Request-Id": requestId } : {},
      body: form,
    });

    const headersMs = Math.round(performance.now() - startedAt);
    console.info("[Inbox image request]", { requestId, headersMs, status: res.status });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error = new Error(body.error || `Request failed (${res.status})`);
      error.status = res.status;
      error.code = body.code || null;
      error.policyBlocked = body.policyBlocked === true;
      throw error;
    }
    const result = await res.json();
    console.info("[Inbox image request]", { requestId, headersMs, totalMs: Math.round(performance.now() - startedAt), status: res.status });
    return result;
  },
  sendVideo: async (contactId, file, caption, replyToMessageId = null, requestId = null) => {
    const form = new FormData();
    form.append("video", file);
    if (caption) form.append("caption", caption);
    if (replyToMessageId != null) form.append("replyToMessageId", String(replyToMessageId));

    const res = await fetch(`${BASE}/conversations/${contactId}/video`, {
      method: "POST",
      credentials: "include",
      headers: requestId ? { "X-Inbox-Request-Id": requestId } : {},
      body: form,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error = new Error(body.error || `Request failed (${res.status})`);
      error.status = res.status;
      error.code = body.code || null;
      error.policyBlocked = body.policyBlocked === true;
      throw error;
    }
    return res.json();
  },
  sendDocument: async (contactId, file, caption, replyToMessageId = null, requestId = null) => {
    const form = new FormData();
    form.append("document", file);
    if (caption) form.append("caption", caption);
    if (replyToMessageId != null) form.append("replyToMessageId", String(replyToMessageId));

    const res = await fetch(`${BASE}/conversations/${contactId}/document`, {
      method: "POST",
      credentials: "include",
      headers: requestId ? { "X-Inbox-Request-Id": requestId } : {},
      body: form,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error = new Error(body.error || `Request failed (${res.status})`);
      error.status = res.status;
      error.code = body.code || null;
      error.policyBlocked = body.policyBlocked === true;
      throw error;
    }
    return res.json();
  },
  sendVoice: async (contactId, recording, mimeType, replyToMessageId = null) => {
    const form = new FormData();
    const extension = mimeType?.includes("mp4") ? "m4a" : mimeType?.includes("ogg") ? "ogg" : "webm";
    form.append("voice", recording, `voice-recording.${extension}`);
    if (replyToMessageId != null) form.append("replyToMessageId", String(replyToMessageId));

    const res = await fetch(`${BASE}/conversations/${contactId}/voice`, {
      method: "POST",
      credentials: "include",
      body: form,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error = new Error(body.error || `Request failed (${res.status})`);
      error.status = res.status;
      error.code = body.code || null;
      error.policyBlocked = body.policyBlocked === true;
      throw error;
    }
    return res.json();
  },
  takeOver: (contactId) => request(`/conversations/${contactId}/takeover`, { method: "POST" }),
  returnToAi: (contactId, expectedUpdatedAt) => request(`/conversations/${contactId}/return-to-ai`, {
    method: "POST",
    body: JSON.stringify({ expectedUpdatedAt }),
  }),
  setAttention: (contactId, needsAttention, reason) =>
    request(`/conversations/${contactId}/attention`, {
      method: "PATCH",
      body: JSON.stringify({ needsAttention, reason }),
    }),
  setReadState: (contactId, unread) =>
    request(`/conversations/${contactId}/read-state`, {
      method: "PATCH",
      body: JSON.stringify({ unread }),
    }),
  setInboxArchived: (contactId, archived) =>
    request(`/conversations/${contactId}/archive`, {
      method: "PATCH",
      body: JSON.stringify({ archived }),
    }),
  setFollowUp: (contactId, needsFollowUp) =>
    request(`/conversations/${contactId}/follow-up`, {
      method: "PATCH",
      body: JSON.stringify({ needsFollowUp }),
    }),
  getConfig: () => request("/config"),
  updateConfig: (updates) => request("/config", { method: "PATCH", body: JSON.stringify(updates) }),
  getAdvancedConfig: () => request("/advanced-config"),
  previewAdvancedConfig: (config) =>
    request("/advanced-config/preview", {
      method: "POST",
      body: JSON.stringify({ config }),
    }),
  applyAdvancedConfig: (config, baseFingerprint) =>
    request("/advanced-config/apply", {
      method: "POST",
      body: JSON.stringify({ config, baseFingerprint }),
    }),
  restoreAdvancedConfig: (snapshotId) =>
    request(`/advanced-config/restore/${snapshotId}`, { method: "POST" }),
  getCommentAutomationStatus: () => request("/config/comment-automation/status"),
  getFreeEntryStatus: () => request("/config/automated-follow-up/free-entry-status"),
  getFollowUpPerformance: (filters = {}) => request(`/follow-up-performance?${new URLSearchParams({ days: String(filters.days ?? 30), channel: filters.channel ?? "all" })}`),
  getFollowUpHealth: (filters = {}) => request(`/follow-up-health?${new URLSearchParams({ days: String(filters.days ?? 7), channel: filters.channel ?? "all" })}`),
  getFollowUpActivity: (filters = {}) => {
    const params = new URLSearchParams();
    for (const key of ["days", "channel", "type", "state", "page"]) {
      if (filters[key] != null) params.set(key, String(filters[key]));
    }
    return request(`/follow-up-activity?${params.toString()}`);
  },
  getFollowUpTemplateCatalog: ({ refresh = false } = {}) =>
    request(`/config/automated-follow-up/template-catalog${refresh ? "?refresh=true" : ""}`),
  followUpTemplateMediaPreviewUrl: (key) =>
    `${BASE}/config/automated-follow-up/template-media-preview?key=${encodeURIComponent(key)}`,
  uploadFollowUpTemplateImage: async (file) => {
    const body = new FormData();
    body.append("image", file);
    const res = await fetch(`${BASE}/config/automated-follow-up/template-media-image`, {
      method: "POST", credentials: "include", body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
    return data;
  },
  importFollowUpTemplateImage: (selectionId) =>
    request("/config/automated-follow-up/template-library-image", {
      method: "POST", body: JSON.stringify({ selectionId }),
    }),
  verifyFollowUpTemplateVideo: (selectionId) =>
    request("/config/automated-follow-up/template-library-video", {
      method: "POST", body: JSON.stringify({ selectionId }),
    }),
  reconcileWhatsAppFreeOnly: (payload) => request("/config/automated-follow-up/free-only-reconcile", { method: "POST", body: JSON.stringify(payload) }),
  getLeadDistributionStatus: () => request("/config/lead-distribution/status"),
  recoverUnassignedLeads: () =>
    request("/config/lead-distribution/recover-unassigned", { method: "POST" }),
  uploadPromoImage: async (file) => {
    const form = new FormData();
    form.append("image", file);

    const res = await fetch(`${BASE}/config/promotions/image`, {
      method: "POST",
      credentials: "include",
      body: form,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error = new Error(body.error || `Request failed (${res.status})`);
      error.status = res.status;
      throw error;
    }
    return res.json();
  },
  uploadResultMediaImage: async (file) => {
    const form = new FormData();
    form.append("image", file);

    const res = await fetch(`${BASE}/config/result-media/image`, {
      method: "POST",
      credentials: "include",
      body: form,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error = new Error(body.error || `Request failed (${res.status})`);
      error.status = res.status;
      throw error;
    }
    return res.json();
  },
  uploadFollowUpImage: async (file) => {
    const form = new FormData();
    form.append("image", file);

    const res = await fetch(`${BASE}/config/automated-follow-up/image`, {
      method: "POST",
      credentials: "include",
      body: form,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error = new Error(body.error || `Request failed (${res.status})`);
      error.status = res.status;
      throw error;
    }
    return res.json();
  },
  uploadFollowUpVideo: async (file) => {
    const form = new FormData();
    form.append("video", file);

    const res = await fetch(`${BASE}/config/automated-follow-up/video`, {
      method: "POST",
      credentials: "include",
      body: form,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error = new Error(body.error || `Request failed (${res.status})`);
      error.status = res.status;
      throw error;
    }
    return res.json();
  },
  uploadFollowUpVoice: async (file, language) => {
    const form = new FormData();
    form.append("voice", file);
    form.append("language", language);
    const res = await fetch(`${BASE}/config/automated-follow-up/voice`, {
      method: "POST", credentials: "include", body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    return res.json();
  },
  translateFollowUp: (message) =>
    request("/config/automated-follow-up/translations", {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  translateFollowUps: (messages) =>
    request("/config/automated-follow-up/translations", {
      method: "POST",
      body: JSON.stringify({ messages }),
    }),
  listContacts: (search) => request(`/contacts${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  listContactsPage: ({
    search = "", assignment = "all", offset = 0, limit = 60, includeOwners = false,
  } = {}) => {
    const params = new URLSearchParams({
      search, assignment, offset: String(offset), limit: String(limit),
      includeOwners: String(includeOwners),
    });
    return request("/contacts/paged?" + params.toString(), { cache: "no-store" });
  },
  downloadCustomerExport: ({ preset = "customer", scope = "current", search = "", assignment = "all" } = {}) => {
    const params = new URLSearchParams({ preset, scope });
    if (scope === "current") {
      if (search) params.set("search", search);
      if (assignment && assignment !== "all") params.set("assignment", assignment);
    }
    return download(`/contacts/export?${params.toString()}`);
  },
  getContact: (id) => request(`/contacts/${id}`),
  getContactInsights: (id) => request(`/contacts/${id}/insights`),
  createContact: (data) => request("/contacts", { method: "POST", body: JSON.stringify(data) }),
  updateContact: (id, data) => request(`/contacts/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteCustomerData: (id) =>
    request(`/contacts/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ confirm: "DELETE" }),
    }),
  listContactNotes: (id) => request(`/contacts/${id}/notes`),
  addContactNote: (id, content) =>
    request(`/contacts/${id}/notes`, { method: "POST", body: JSON.stringify({ content }) }),
  deleteContactNote: (id, noteId) => request(`/contacts/${id}/notes/${noteId}`, { method: "DELETE" }),
  getSalesFollowUps: () => request("/sales-follow-up"),
  getRecentSalesFollowUps: () => request("/sales-follow-up/recent"),
  undoSalesFollowUp: (leadId, eventId) => request(`/sales-follow-up/${leadId}/undo`, { method: "POST", body: JSON.stringify({ eventId }) }),
  updateSalesFollowUp: (leadId, payload) => request(`/sales-follow-up/${leadId}/outcome`, { method: "PATCH", body: JSON.stringify(payload) }),
  downloadSalesFollowUps: (period = "weekly") => download(`/sales-follow-up/export?period=${encodeURIComponent(period)}`),
  getPipeline: () => request("/pipeline"),
  getConfiguredBranches: () => request("/pipeline/configured-branches"),
  getAnalytics: (filters = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value != null && value !== "" && value !== "all") params.set(key, String(value));
    }
    const query = params.toString();
    return request(`/pipeline/analytics${query ? `?${query}` : ""}`);
  },
  getAiCostAnalytics: ({ days = 7 } = {}) => request(`/pipeline/analytics/ai-costs?days=${encodeURIComponent(days)}`),
  getMetaAdsAnalytics: (filters = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value != null && value !== "" && value !== "all") params.set(key, String(value));
    }
    const query = params.toString();
    return request(`/pipeline/analytics/meta-ads${query ? `?${query}` : ""}`);
  },
  getMetaAdsAnalyticsLeads: (filters = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value != null && value !== "" && value !== "all") params.set(key, String(value));
    }
    const query = params.toString();
    return request(`/pipeline/analytics/meta-ads/leads${query ? `?${query}` : ""}`);
  },
  getGoLiveGate: () => request("/go-live"),
  runGoLiveGate: () => request("/go-live/run", { method: "POST" }),
  getSetupStatus: () => request("/setup-status"),
  runSetupChecks: () => request("/setup-status/run", { method: "POST" }),
  selectBusinessProfile: (businessType) =>
    request("/setup-status/business-profile", {
      method: "POST",
      body: JSON.stringify({ businessType }),
    }),
  getGeminiDiagnosticStatus: () => request("/setup-status/gemini-diagnostic/status"),
  runGeminiDiagnostic: () => request("/setup-status/gemini-diagnostic", { method: "POST" }),
  getWhatsAppCoexistenceOnboardingConfig: () =>
    request("/whatsapp-coexistence/onboarding/config"),
  completeWhatsAppCoexistenceOnboarding: (payload) =>
    request("/whatsapp-coexistence/onboarding/complete", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  createLead: (data) =>
    request("/pipeline/leads", { method: "POST", body: JSON.stringify(data) }),
  updateLead: (leadId, data) =>
    request(`/pipeline/leads/${leadId}`, { method: "PATCH", body: JSON.stringify(data) }),
  listLeadActivities: (leadId) => request(`/pipeline/leads/${leadId}/activities`),
  resolveLeadBookingReview: (leadId) => request(`/pipeline/leads/${leadId}/booking-review/resolve`, {method:"POST", body:JSON.stringify({confirmed:true})}),
  getAssessmentVoucher: (leadId) =>
    request(`/pipeline/leads/${leadId}/assessment-voucher`),
  updateAssessmentVoucher: (leadId, payload) =>
    request(`/pipeline/leads/${leadId}/assessment-voucher`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  addLeadNote: (leadId, content) =>
    request(`/pipeline/leads/${leadId}/notes`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  createPipelineStage: (data) =>
    request("/pipeline/stages", { method: "POST", body: JSON.stringify(data) }),
  updatePipelineStage: (stageId, data) =>
    request(`/pipeline/stages/${stageId}`, { method: "PATCH", body: JSON.stringify(data) }),
  reorderPipelineStages: (stageIds) =>
    request("/pipeline/stages/reorder", {
      method: "POST",
      body: JSON.stringify({ stageIds }),
    }),
  deletePipelineStage: (stageId) =>
    request(`/pipeline/stages/${stageId}`, { method: "DELETE" }),
};
