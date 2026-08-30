const BASE = "/api";

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error = new Error(body.error || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }

  return res.json();
}

export const api = {
  login: (username, password) =>
    request("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request("/auth/logout", { method: "POST" }),
  me: () => request("/auth/me"),
  listConversations: () => request("/conversations"),
  getMessages: (
    contactId,
    { includeMedia = false, limit = 50, beforeId = null, afterId = null } = {}
  ) => {
    const params = new URLSearchParams();
    params.set("includeMedia", includeMedia ? "true" : "false");
    params.set("limit", String(limit));
    if (beforeId != null) params.set("beforeId", String(beforeId));
    if (afterId != null) params.set("afterId", String(afterId));
    return request(`/conversations/${contactId}/messages?${params.toString()}`);
  },
  messageMediaUrl: (contactId, messageId) =>
    `${BASE}/conversations/${contactId}/messages/${messageId}/media`,
  sendMessage: (contactId, text) =>
    request(`/conversations/${contactId}/messages`, { method: "POST", body: JSON.stringify({ text }) }),
  retryMessage: (contactId, messageId) =>
    request(`/conversations/${contactId}/messages/${messageId}/retry`, { method: "POST" }),
  getMessageDeliveryStatuses: (contactId, messageIds) =>
    request(`/conversations/${contactId}/messages/delivery-statuses`, {
      method: "POST",
      body: JSON.stringify({ messageIds }),
    }),
  sendImage: async (contactId, file, caption) => {
    const form = new FormData();
    form.append("image", file);
    if (caption) form.append("caption", caption);

    const res = await fetch(`${BASE}/conversations/${contactId}/media`, {
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
  sendVoice: async (contactId, recording, mimeType) => {
    const form = new FormData();
    const extension = mimeType?.includes("mp4") ? "m4a" : mimeType?.includes("ogg") ? "ogg" : "webm";
    form.append("voice", recording, `voice-recording.${extension}`);

    const res = await fetch(`${BASE}/conversations/${contactId}/voice`, {
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
  takeOver: (contactId) => request(`/conversations/${contactId}/takeover`, { method: "POST" }),
  returnToAi: (contactId) => request(`/conversations/${contactId}/return-to-ai`, { method: "POST" }),
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
  setFollowUp: (contactId, needsFollowUp) =>
    request(`/conversations/${contactId}/follow-up`, {
      method: "PATCH",
      body: JSON.stringify({ needsFollowUp }),
    }),
  getConfig: () => request("/config"),
  updateConfig: (updates) => request("/config", { method: "PATCH", body: JSON.stringify(updates) }),
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
  translateFollowUp: (message) =>
    request("/config/automated-follow-up/translations", {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  listContacts: (search) => request(`/contacts${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  getContact: (id) => request(`/contacts/${id}`),
  getContactInsights: (id) => request(`/contacts/${id}/insights`),
  createContact: (data) => request("/contacts", { method: "POST", body: JSON.stringify(data) }),
  updateContact: (id, data) => request(`/contacts/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  listContactNotes: (id) => request(`/contacts/${id}/notes`),
  addContactNote: (id, content) =>
    request(`/contacts/${id}/notes`, { method: "POST", body: JSON.stringify({ content }) }),
  deleteContactNote: (id, noteId) => request(`/contacts/${id}/notes/${noteId}`, { method: "DELETE" }),
  getPipeline: () => request("/pipeline"),
  createLead: (data) =>
    request("/pipeline/leads", { method: "POST", body: JSON.stringify(data) }),
  updateLead: (leadId, data) =>
    request(`/pipeline/leads/${leadId}`, { method: "PATCH", body: JSON.stringify(data) }),
  listLeadActivities: (leadId) => request(`/pipeline/leads/${leadId}/activities`),
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
