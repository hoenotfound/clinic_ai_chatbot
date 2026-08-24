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
  takeOver: (contactId) => request(`/conversations/${contactId}/takeover`, { method: "POST" }),
  returnToAi: (contactId) => request(`/conversations/${contactId}/return-to-ai`, { method: "POST" }),
  setAttention: (contactId, needsAttention, reason) =>
    request(`/conversations/${contactId}/attention`, {
      method: "PATCH",
      body: JSON.stringify({ needsAttention, reason }),
    }),
};
