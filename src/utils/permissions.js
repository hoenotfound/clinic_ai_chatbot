const ROLES = new Set(["admin", "sales"]);

const CAPABILITY_DEFINITIONS = [
  {
    key: "view_assigned_leads",
    label: "View assigned leads",
    description: "See Inbox, Contacts and Pipeline records assigned to this account.",
    defaults: { admin: true, sales: true },
  },
  {
    key: "reply_to_assigned_leads",
    label: "Reply to assigned leads",
    description: "Send text, image and voice replies, and retry failed replies for assigned leads.",
    defaults: { admin: true, sales: true },
  },
  {
    key: "manage_assigned_leads",
    label: "Manage assigned leads",
    description: "Take over chats, update lead details/stages, flags, follow-ups and notes for assigned leads.",
    defaults: { admin: true, sales: true },
  },
  {
    key: "create_leads",
    label: "Create contacts and leads",
    description: "Create new contacts and manually add leads. Without assignment permission, new leads are assigned to the creator.",
    defaults: { admin: true, sales: false },
  },
  {
    key: "view_all_leads",
    label: "Access all leads",
    description: "See every clinic lead and conversation. Any enabled reply or lead-management capabilities also apply across this clinic-wide view.",
    defaults: { admin: true, sales: false },
  },
  {
    key: "manage_lead_assignment",
    label: "Assign leads",
    description: "Assign or reassign leads between staff accounts.",
    defaults: { admin: true, sales: false },
  },
  {
    key: "manage_pipeline_stages",
    label: "Manage pipeline stages",
    description: "Create, rename, reorder and remove Pipeline stages.",
    defaults: { admin: true, sales: false },
  },
  {
    key: "view_analytics",
    label: "View Analytics",
    description: "Open the global Analytics dashboard and view clinic-wide performance.",
    defaults: { admin: true, sales: false },
  },
  {
    key: "manage_tools",
    label: "Manage automation tools",
    description: "Open Tools and change follow-up, lead-scoring, and lead-distribution settings.",
    defaults: { admin: true, sales: false },
  },
  {
    key: "manage_settings",
    label: "Manage clinic & AI settings",
    description: "Edit clinic information, services, promotions, AI behavior and handoff rules.",
    defaults: { admin: true, sales: false },
  },
  {
    key: "manage_users",
    label: "Manage team access",
    description: "Add/remove staff, change roles, reset passwords and configure capabilities.",
    defaults: { admin: true, sales: false },
  },
];

const CAPABILITY_KEYS = new Set(CAPABILITY_DEFINITIONS.map((item) => item.key));

function normalizeRole(role) {
  return ROLES.has(role) ? role : "sales";
}

function roleDefaults(role) {
  const normalizedRole = normalizeRole(role);
  return Object.fromEntries(
    CAPABILITY_DEFINITIONS.map((item) => [item.key, item.defaults[normalizedRole] === true])
  );
}

function normalizePermissionOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, enabled]) => CAPABILITY_KEYS.has(key) && typeof enabled === "boolean"
    )
  );
}

function effectivePermissions(user) {
  return {
    ...roleDefaults(user?.role),
    ...normalizePermissionOverrides(user?.permissions),
  };
}

function hasCapability(user, capability) {
  return effectivePermissions(user)[capability] === true;
}

function presentUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    role: normalizeRole(user.role),
    isActive: user.is_active !== false,
    permissions: effectivePermissions(user),
    createdAt: user.created_at || null,
  };
}

function publicPermissionDefinitions() {
  return CAPABILITY_DEFINITIONS.map(({ key, label, description }) => ({
    key,
    label,
    description,
  }));
}

module.exports = {
  CAPABILITY_DEFINITIONS,
  CAPABILITY_KEYS,
  effectivePermissions,
  hasCapability,
  normalizePermissionOverrides,
  normalizeRole,
  presentUser,
  publicPermissionDefinitions,
  roleDefaults,
};
