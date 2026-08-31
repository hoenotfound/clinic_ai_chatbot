const BASE = "/api/auth";

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

export const teamApi = {
  listUsers: () => request("/users"),
  createUser: (data) =>
    request("/users", { method: "POST", body: JSON.stringify(data) }),
  updateUser: (userId, data) =>
    request(`/users/${userId}`, { method: "PATCH", body: JSON.stringify(data) }),
  removeUser: (userId) => request(`/users/${userId}`, { method: "DELETE" }),
};
