const usersRepo = require("../db/usersRepo");
const {
  canAccessContact,
  canAccessLead,
  filterLeadsForUser,
  filterRowsByAccessibleContacts,
  getAccessibleContactIds,
  getAccessibleLeadIds,
} = require("../utils/accessControl");
const { effectivePermissions, hasCapability } = require("../utils/permissions");

function forbidden(res, message = "You don't have permission to do that.") {
  return res.status(403).json({ error: message });
}

function hasAnyLeadView(user) {
  return hasCapability(user, "view_all_leads") || hasCapability(user, "view_assigned_leads");
}

function segments(req) {
  return String(req.path || "")
    .split("/")
    .filter(Boolean);
}

function positiveId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function wrapJson(res, transform) {
  const originalJson = res.json.bind(res);
  res.json = (body) => originalJson(transform(body));
}

async function enforceConversationsPolicy(req, res, user) {
  const parts = segments(req);
  if (parts.length === 0) {
    if (req.method !== "GET" || !hasAnyLeadView(user)) return forbidden(res);
    if (!hasCapability(user, "view_all_leads")) {
      const accessibleIds = await getAccessibleContactIds(user);
      wrapJson(res, (body) =>
        Array.isArray(body)
          ? filterRowsByAccessibleContacts(body, accessibleIds, "contact_id")
          : body
      );
    }
    return true;
  }

  if (parts[0] === "events") {
    if (!hasAnyLeadView(user)) return forbidden(res);
    // realtimeEvents reads this snapshot to avoid broadcasting other staff's
    // contact/lead identifiers to a restricted SSE connection.
    req.user.realtimeAccess = {
      contactIds: await getAccessibleContactIds(user),
      leadIds: await getAccessibleLeadIds(user),
    };
    return true;
  }

  const contactId = positiveId(parts[0]);
  if (!contactId) return forbidden(res);
  if (!(await canAccessContact(user, contactId))) {
    return forbidden(res, "This conversation isn't assigned to you.");
  }

  const action = parts[1] || "";
  const subAction = parts[2] || "";
  const fourth = parts[3] || "";

  const isSend =
    req.method === "POST" &&
    (
      (action === "messages" && parts.length === 2) ||
      action === "media" ||
      action === "voice" ||
      (action === "messages" && fourth === "retry")
    );

  if (isSend && !hasCapability(user, "reply_to_assigned_leads")) {
    return forbidden(res, "Replying to leads is disabled for this account.");
  }

  const isConversationManagement =
    (req.method === "POST" && ["takeover", "return-to-ai"].includes(action)) ||
    (req.method === "PATCH" && ["attention", "read-state", "follow-up"].includes(action));

  if (isConversationManagement && !hasCapability(user, "manage_assigned_leads")) {
    return forbidden(res, "Managing assigned leads is disabled for this account.");
  }

  // POST /messages/delivery-statuses is a read-style request and intentionally
  // only needs view access. Other GET/media/message history requests do too.
  void subAction;
  return true;
}

async function enforceContactsPolicy(req, res, user) {
  const parts = segments(req);
  if (parts.length === 0) {
    if (req.method === "GET") {
      if (!hasAnyLeadView(user)) return forbidden(res);
      if (!hasCapability(user, "view_all_leads")) {
        const accessibleIds = await getAccessibleContactIds(user);
        wrapJson(res, (body) =>
          Array.isArray(body)
            ? filterRowsByAccessibleContacts(body, accessibleIds, "id")
            : body
        );
      }
      return true;
    }
    if (req.method === "POST") {
      if (!hasCapability(user, "create_leads")) {
        return forbidden(res, "Creating contacts and leads is disabled for this account.");
      }
      return true;
    }
    return forbidden(res);
  }

  const contactId = positiveId(parts[0]);
  if (!contactId || !(await canAccessContact(user, contactId))) {
    return forbidden(res, "This contact isn't assigned to you.");
  }

  const isWrite = req.method !== "GET" && req.method !== "HEAD";
  if (isWrite && !hasCapability(user, "manage_assigned_leads")) {
    return forbidden(res, "Managing assigned leads is disabled for this account.");
  }
  return true;
}

async function enforcePipelinePolicy(req, res, user) {
  const parts = segments(req);
  if (parts.length === 0) {
    if (req.method !== "GET" || !hasAnyLeadView(user)) return forbidden(res);
    if (!hasCapability(user, "view_all_leads")) {
      wrapJson(res, (body) => {
        if (!body || !Array.isArray(body.leads)) return body;
        const leads = filterLeadsForUser(body.leads, user);
        const stageCounts = new Map();
        for (const lead of leads) {
          stageCounts.set(lead.stage_id, (stageCounts.get(lead.stage_id) || 0) + 1);
        }
        return {
          ...body,
          leads,
          stages: Array.isArray(body.stages)
            ? body.stages.map((stage) => ({
                ...stage,
                lead_count: stageCounts.get(stage.id) || 0,
              }))
            : body.stages,
          owners: hasCapability(user, "manage_lead_assignment")
            ? body.owners
            : [user.username],
        };
      });
    }
    return true;
  }

  if (parts[0] === "analytics") {
    if (!hasCapability(user, "view_analytics")) {
      return forbidden(res, "Analytics access is disabled for this account.");
    }
    return true;
  }

  if (parts[0] === "stages") {
    if (!hasCapability(user, "manage_pipeline_stages")) {
      return forbidden(res, "Pipeline stage management is disabled for this account.");
    }
    return true;
  }

  if (parts[0] !== "leads") return true;

  if (parts.length === 1 && req.method === "POST") {
    if (!hasCapability(user, "create_leads")) {
      return forbidden(res, "Creating contacts and leads is disabled for this account.");
    }
    if (!hasCapability(user, "manage_lead_assignment")) {
      req.body = { ...(req.body || {}), ownerUsername: user.username };
    }
    return true;
  }

  const leadId = positiveId(parts[1]);
  if (!leadId || !(await canAccessLead(user, leadId))) {
    return forbidden(res, "This lead isn't assigned to you.");
  }

  if (req.method === "GET") return true;

  if (!hasCapability(user, "manage_assigned_leads")) {
    return forbidden(res, "Managing assigned leads is disabled for this account.");
  }

  if (
    req.method === "PATCH" &&
    Object.prototype.hasOwnProperty.call(req.body || {}, "ownerUsername") &&
    !hasCapability(user, "manage_lead_assignment")
  ) {
    return forbidden(res, "Lead assignment is disabled for this account.");
  }
  return true;
}

function enforceConfigPolicy(req, res, user) {
  const parts = segments(req);
  const canSettings = hasCapability(user, "manage_settings");
  const canTools = hasCapability(user, "manage_tools");

  if (parts.length === 0 && req.method === "GET") {
    if (!canSettings && !canTools) return forbidden(res);
    if (!canSettings && canTools) {
      wrapJson(res, (body) => ({
        automatedFollowUp: body?.automatedFollowUp,
        leadScoring: body?.leadScoring,
      }));
    }
    return true;
  }

  if (parts.length === 0 && req.method === "PATCH") {
    const keys = Object.keys(req.body || {});
    const toolOnly = keys.length > 0 && keys.every((key) => ["automatedFollowUp", "leadScoring"].includes(key));
    if (toolOnly && canTools) return true;
    if (canSettings) return true;
    return forbidden(res);
  }

  if (parts[0] === "automated-follow-up") {
    return canTools ? true : forbidden(res, "Automation tools are disabled for this account.");
  }

  return canSettings ? true : forbidden(res, "Clinic settings are disabled for this account.");
}

async function enforceRoutePolicy(req, res, user) {
  if (req.baseUrl === "/api/conversations") {
    return enforceConversationsPolicy(req, res, user);
  }
  if (req.baseUrl === "/api/contacts") {
    return enforceContactsPolicy(req, res, user);
  }
  if (req.baseUrl === "/api/pipeline") {
    return enforcePipelinePolicy(req, res, user);
  }
  if (req.baseUrl === "/api/config") {
    return enforceConfigPolicy(req, res, user);
  }
  return true;
}

async function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Not logged in." });
  }

  try {
    const user = await usersRepo.getUserById(req.session.userId);
    if (!user || user.is_active === false) {
      req.session = null;
      return res.status(401).json({ error: "This account is no longer active." });
    }

    req.session.username = user.username;
    req.user = {
      ...user,
      permissions: effectivePermissions(user),
    };

    const allowed = await enforceRoutePolicy(req, res, req.user);
    if (allowed !== true) return;
    next();
  } catch (err) {
    console.error("Authorization check failed:", err);
    return res.status(500).json({ error: "Something went wrong checking account access." });
  }
}

function requireCapability(capability) {
  return (req, res, next) => {
    if (!req.user || !hasCapability(req.user, capability)) {
      return forbidden(res);
    }
    next();
  };
}

module.exports = { requireAuth, requireCapability };
