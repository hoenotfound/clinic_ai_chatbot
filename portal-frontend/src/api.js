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
  getMessages: (contactId) => request(`/conversations/${contactId}/messages`),
  sendMessage: (contactId, text) =>
    request(`/conversations/${contactId}/messages`, { method: "POST", body: JSON.stringify({ text }) }),
  // Multipart upload — bypasses the JSON `request()` helper above since a
  // File can't be JSON-stringified and must NOT have a manual
  // Content-Type header (the browser sets the multipart boundary itself).
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
  takeOver: (contactId) => request(`/conversations/${contactId}/takeover`, { method: "POST" }),
  returnToAi: (contactId) => request(`/conversations/${contactId}/return-to-ai`, { method: "POST" }),
  setAttention: (contactId, needsAttention, reason) =>
    request(`/conversations/${contactId}/attention`, {
      method: "PATCH",
      body: JSON.stringify({ needsAttention, reason }),
    }),
  // Clinic config (Settings page) — partial update, only the keys included
  // in `updates` are changed server-side; everything else is left as-is.
  getConfig: () => request("/config"),
  updateConfig: (updates) => request("/config", { method: "PATCH", body: JSON.stringify(updates) }),
  // Uploads a promo graphic file directly (Settings > Promotions) instead of
  // requiring an already-hosted URL. Same multipart pattern as sendImage
  // above. Returns { url } — a public link the server will serve the image
  // back from, ready to drop straight into a promotion's imageUrl field.
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
  // Cleans up a promo image row that's no longer referenced (replaced or
  // removed in Settings > Promotions). Takes the row id — callers get it
  // via extractPromoImageId() below. See ImageFieldEditor in Settings.jsx.
  deletePromoImage: (id) => request(`/config/promotions/image/${id}`, { method: "DELETE" }),
  // ── Contacts directory (Contacts nav item) ──
  listContacts: (search) => request(`/contacts${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  getContact: (id) => request(`/contacts/${id}`),
  createContact: (data) => request("/contacts", { method: "POST", body: JSON.stringify(data) }),
  updateContact: (id, data) => request(`/contacts/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  listContactNotes: (id) => request(`/contacts/${id}/notes`),
  addContactNote: (id, content) =>
    request(`/contacts/${id}/notes`, { method: "POST", body: JSON.stringify({ content }) }),
  deleteContactNote: (id, noteId) => request(`/contacts/${id}/notes/${noteId}`, { method: "DELETE" }),
};

// Pulls the numeric id out of one of our own hosted promo-image URLs, e.g.
// "https://host/promo-images/42" -> 42. Returns null for anything else
// (a staff-pasted external URL, an empty value, etc.) so callers know not
// to try deleting something we don't own.
export function extractPromoImageId(url) {
  if (!url) return null;
  const match = String(url).match(/\/promo-images\/(\d+)(?:[/?#]|$)/);
  return match ? Number(match[1]) : null;
}
