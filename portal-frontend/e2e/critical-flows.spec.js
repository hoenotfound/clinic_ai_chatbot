import { expect, test } from "@playwright/test";

const STAFF_USER = {
  id: 2,
  username: "sales-test",
  displayName: "Sales Test",
  role: "sales",
  permissions: {
    view_all_leads: true,
    view_assigned_leads: true,
    reply_to_assigned_leads: true,
    manage_assigned_leads: true,
    view_analytics: true,
    manage_tools: true,
    manage_settings: true,
    create_leads: true,
    manage_pipeline_stages: true,
    manage_lead_assignment: true,
    export_customer_data: true,
    delete_customer_data: true,
  },
  businessProfile: null,
};

function recentIso() {
  return new Date(Date.now() - 5 * 60 * 1000).toISOString();
}

function conversation(overrides = {}) {
  return {
    contact_id: 101,
    name: "Alex Customer",
    whatsapp_profile_name: "Alex Customer",
    whatsapp_number: "+60123456789",
    channel: "whatsapp",
    mode: "ai",
    takeover_by: null,
    takeover_at: null,
    latest_inbound_at: recentIso(),
    latest_customer_message_at: recentIso(),
    last_message_at: recentIso(),
    last_message_role: "user",
    last_message_content: "Hi, I would like to know more.",
    has_unreplied: true,
    is_unread: false,
    needs_attention: false,
    needs_follow_up: false,
    lead_owner_username: null,
    lead_owner_display_name: null,
    ...overrides,
  };
}

function contactFixture(overrides = {}) {
  return {
    id: 101,
    name: "Alex Customer",
    whatsapp_profile_name: "Alex Customer",
    whatsapp_number: "60123456789",
    channel: "whatsapp",
    channel_user_id: "60123456789",
    mode: "ai",
    needs_attention: false,
    is_unread: false,
    needs_follow_up: false,
    created_at: recentIso(),
    updated_at: recentIso(),
    lead_owner_username: "sales-test",
    lead_owner_display_name: "Sales Test",
    message_count: 1,
    last_message_at: recentIso(),
    ...overrides,
  };
}

function inboundMessages() {
  return [{
    id: 1,
    role: "user",
    content: "Hi, I would like to know more.",
    created_at: recentIso(),
    media_url: null,
    media_base64: null,
    media_mime_type: null,
    whatsapp_message_id: "wamid.customer.1",
  }];
}

function pipelineFixture() {
  return {
    stages: [
      { id: 1, name: "New", color: "#64748b", stage_type: "open" },
      { id: 2, name: "Contacted", color: "#2563eb", stage_type: "open" },
      { id: 3, name: "Appointment", color: "#16a34a", stage_type: "open" },
    ],
    leads: [{
      id: 501,
      contact_id: 101,
      stage_id: 1,
      name: "Alex Tan",
      whatsapp_profile_name: "Alex Tan",
      whatsapp_number: "+60123456789",
      channel: "whatsapp",
      temperature: "warm",
      treatment_interest: "Body assessment",
      branch_name: "PJ",
      owner_username: "sales-test",
      source: "whatsapp",
      attribution: null,
      appointment_status: null,
      appointment_at: null,
      next_follow_up_at: null,
      needs_attention: false,
      is_closed: false,
      estimated_value: 500,
      last_message_at: recentIso(),
      created_at: recentIso(),
      journey_started_at: recentIso(),
    }],
    branches: ["PJ"],
    owners: [],
    services: ["Body assessment"],
    noReplyHours: 24,
  };
}

async function stubRealtime(page) {
  await page.addInitScript(() => {
    class MockEventSource {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;

      constructor(url) {
        this.url = String(url);
        this.readyState = MockEventSource.OPEN;
        this.withCredentials = true;
        this.listeners = new Map();
      }

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener);
      }

      close() {
        this.readyState = MockEventSource.CLOSED;
      }
    }

    Object.defineProperty(window, "EventSource", {
      configurable: true,
      writable: true,
      value: MockEventSource,
    });
  });
}

async function installApi(page, {
  loggedIn = true,
  initialConversations = [conversation()],
  initialMessages = inboundMessages(),
  initialPipeline = pipelineFixture(),
  initialContacts = [contactFixture()],
  authUser = STAFF_USER,
  initialVoucher = null,
  voucherWriteError = false,
  archiveWriteError = false,
  verifiedFreeTemplateWindow = false,
  freeTemplateSendReady = true,
} = {}) {
  await stubRealtime(page);

  let authenticated = loggedIn;
  let conversations = initialConversations.map((item) => ({ ...item }));
  let contacts = initialContacts.map((item) => ({ ...item }));
  const messagesByContact = new Map([[101, initialMessages.map((item) => ({ ...item }))]]);
  let pipeline = {
    ...initialPipeline,
    stages: initialPipeline.stages.map((item) => ({ ...item })),
    leads: initialPipeline.leads.map((item) => ({ ...item })),
  };
  let nextMessageId = 2;
  let voucher = initialVoucher ? { ...initialVoucher } : { status: "not_verified", valueRm: 100 };
  let voucherActivities = [];

  const calls = [];
  const unexpected = [];

  function record(request, body = undefined) {
    calls.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      body,
    });
  }

  function fulfill(route, body, status = 200) {
    return route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  }

  function setConversationMode(contactId, mode) {
    conversations = conversations.map((item) => (
      Number(item.contact_id) === Number(contactId)
        ? {
            ...item,
            mode,
            takeover_by: mode === "human" ? STAFF_USER.username : null,
            takeover_at: mode === "human" ? new Date().toISOString() : null,
          }
        : item
    ));
  }

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/auth/branding" && method === "GET") {
      return fulfill(route, {
        clientName: "Test Clinic",
        clientLogoUrl: "",
        loginTagline: "Staff portal",
      });
    }

    if (path === "/api/auth/branding/manifest.webmanifest" && method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/manifest+json",
        body: JSON.stringify({
          name: "Test Clinic",
          short_name: "Test Clinic",
          start_url: "/login",
          scope: "/",
          display: "standalone",
          icons: [
            {
              src: "/app-icons/da-chatbot-192.png",
              sizes: "192x192",
              type: "image/png",
              purpose: "any",
            },
            {
              src: "/app-icons/da-chatbot-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "any",
            },
          ],
        }),
      });
    }

    if (path === "/api/auth/branding/apple-touch-icon.png" && method === "GET") {
      return route.fulfill({ status: 204, body: "" });
    }

    if (path === "/api/auth/me" && method === "GET") {
      if (!authenticated) return fulfill(route, { error: "Not logged in." }, 401);
      return fulfill(route, { username: authUser.username, user: authUser });
    }

    if (path === "/api/auth/login" && method === "POST") {
      const body = request.postDataJSON();
      record(request, body);
      authenticated = true;
      return fulfill(route, { username: authUser.username, user: authUser });
    }

    if (path === "/api/auth/logout" && method === "POST") {
      record(request);
      authenticated = false;
      return fulfill(route, { ok: true });
    }

    if (path === "/api/conversations" && method === "GET") {
      return fulfill(route, conversations);
    }

    if (path === "/api/conversations/directory-search" && method === "GET") {
      const query = (url.searchParams.get("q") || "").trim().toLowerCase();
      const matched = conversations.filter((item) => [
        item.name, item.whatsapp_profile_name, item.whatsapp_number,
      ].filter(Boolean).join(" ").toLowerCase().includes(query)).slice(0, 40);
      return fulfill(route, matched);
    }

    const summaryMatch = path.match(/^\/api\/conversations\/(\d+)\/summary$/);
    if (summaryMatch && method === "GET") {
      const contact = conversations.find((item) =>
        Number(item.contact_id) === Number(summaryMatch[1]));
      return fulfill(route, contact || { error: "Conversation not found" }, contact ? 200 : 404);
    }

    const archiveMatch = path.match(/^\/api\/conversations\/(\d+)\/archive$/);
    if (archiveMatch && method === "PATCH") {
      const body = request.postDataJSON();
      record(request, body);
      if (archiveWriteError) return fulfill(route, { error: "Archive update failed" }, 500);
      conversations = conversations.map((item) => Number(item.contact_id) === Number(archiveMatch[1])
        ? { ...item, inbox_archived_at: body.archived ? recentIso() : null }
        : item);
      return fulfill(route, { contactId: Number(archiveMatch[1]), archived: body.archived });
    }

    const attributionMatch = path.match(/^\/api\/conversations\/(\d+)\/attribution$/);
    if (attributionMatch && method === "GET") {
      return fulfill(route, { lead: null, attribution: null });
    }

    const messageMatch = path.match(/^\/api\/conversations\/(\d+)\/messages$/);
    if (messageMatch && method === "GET") {
      const contactId = Number(messageMatch[1]);
      const allMessages = messagesByContact.get(contactId) || [];
      const afterId = Number(url.searchParams.get("afterId") || 0);
      const beforeId = Number(url.searchParams.get("beforeId") || 0);
      let result = allMessages;
      if (afterId) result = result.filter((item) => Number(item.id) > afterId);
      if (beforeId) result = result.filter((item) => Number(item.id) < beforeId);
      return fulfill(route, { messages: result, hasMore: false });
    }

    if (messageMatch && method === "POST") {
      const contactId = Number(messageMatch[1]);
      const body = request.postDataJSON();
      record(request, body);
      const message = {
        id: nextMessageId++,
        role: "assistant",
        content: body.text,
        sent_by_username: STAFF_USER.username,
        created_at: new Date().toISOString(),
        media_url: null,
        media_base64: null,
        media_mime_type: null,
        whatsapp_message_id: "wamid.test",
        delivery_status: "sent",
        delivered: true,
      };
      messagesByContact.set(contactId, [...(messagesByContact.get(contactId) || []), message]);
      conversations = conversations.map((item) => (
        Number(item.contact_id) === contactId
          ? {
              ...item,
              last_message_role: "assistant",
              last_message_content: body.text,
              last_message_at: message.created_at,
              has_unreplied: false,
            }
          : item
      ));
      return fulfill(route, message);
    }

    const forwardMatch = path.match(/^\/api\/conversations\/(\d+)\/messages\/(\d+)\/forward$/);
    if (forwardMatch && method === "POST") {
      const body = request.postDataJSON();
      record(request, body);
      return fulfill(route, {
        deliveredCount: body.targetContactIds?.length || 0,
        requestedCount: body.targetContactIds?.length || 0,
        results: (body.targetContactIds || []).map((contactId) => ({
          contactId,
          delivered: true,
          error: null,
        })),
      });
    }

    const freeWindowMatch = path.match(/^\/api\/conversations\/(\d+)\/whatsapp-template-free-window$/);
    if (freeWindowMatch && method === "GET") {
      return fulfill(route, { verified: verifiedFreeTemplateWindow, sendReady: verifiedFreeTemplateWindow && freeTemplateSendReady, blockedReason: freeTemplateSendReady ? null : "zero_cost_previous_send_unreconciled" });
    }

    const templateListMatch = path.match(/^\/api\/conversations\/(\d+)\/whatsapp-templates$/);
    if (templateListMatch && method === "GET") {
      const contactId = Number(templateListMatch[1]);
      const contact = conversations.find((item) => Number(item.contact_id) === contactId);
      const optedIn = Boolean(contact?.whatsapp_opt_in_at && contact?.whatsapp_opt_in_source);
      const optedOut = Boolean(contact?.whatsapp_opt_out_at);
      return fulfill(route, {
        billingAdvisory: { evidence: verifiedFreeTemplateWindow ? "recent_free_entry_evidence" : "no_ctwa_referral", freeEntry: { verified: verifiedFreeTemplateWindow, sendReady: verifiedFreeTemplateWindow && freeTemplateSendReady }, reviewTokens: { "lead_follow_up::en_US": "test-review-token" }, reviewedAt: new Date().toISOString() },
        templates: [
          {
            id: "tpl-1",
            name: "lead_follow_up",
            language: "en_US",
            status: "APPROVED",
            category: "MARKETING",
            header: null,
            body: { text: "Hi {{1}}, just following up on your enquiry." },
            footer: { text: "Reply STOP if you no longer want updates." },
            buttons: [],
            variableFields: [
              { component: "body", index: 1, label: "Body {{1}}", example: "Alex" },
            ],
            sendable: true,
            unsupportedReason: null,
          },
        ],
        eligibility: optedOut
          ? { allowed: false, code: "opted_out", message: "Customer opted out." }
          : optedIn
            ? { allowed: true, code: null, message: null }
            : { allowed: false, code: "missing_opt_in", message: "Explicit opt-in required." },
        cached: false,
      });
    }

    const optInMatch = path.match(/^\/api\/conversations\/(\d+)\/whatsapp-opt-in$/);
    if (optInMatch && method === "POST") {
      const contactId = Number(optInMatch[1]);
      const body = request.postDataJSON();
      record(request, body);
      const optInAt = new Date().toISOString();
      conversations = conversations.map((item) => (
        Number(item.contact_id) === contactId
          ? {
              ...item,
              whatsapp_opt_in_at: optInAt,
              whatsapp_opt_in_source: body.source,
              whatsapp_opt_out_at: null,
              whatsapp_opt_out_source: null,
            }
          : item
      ));
      return fulfill(route, {
        contactId,
        whatsapp_opt_in_at: optInAt,
        whatsapp_opt_in_source: body.source,
        whatsapp_opt_out_at: null,
        whatsapp_opt_out_source: null,
      });
    }

    const templateSendMatch = path.match(/^\/api\/conversations\/(\d+)\/whatsapp-templates\/send$/);
    if (templateSendMatch && method === "POST") {
      const contactId = Number(templateSendMatch[1]);
      const body = request.postDataJSON();
      record(request, body);
      const customerName = body.values?.body?.[0] || "{{1}}";
      const message = {
        id: nextMessageId++,
        contact_id: contactId,
        role: "assistant",
        content: `Hi ${customerName}, just following up on your enquiry.\n\nReply STOP if you no longer want updates.`,
        sent_by_username: STAFF_USER.username,
        created_at: new Date().toISOString(),
        whatsapp_message_id: "wamid.template-test",
        delivery_status: "pending",
        delivery_error: null,
        is_automated_follow_up: false,
        whatsapp_template: {
          name: body.templateName,
          language: body.languageCode,
          category: "MARKETING",
          components: [
            {
              type: "body",
              parameters: [{ type: "text", text: customerName }],
            },
          ],
        },
        delivered: true,
      };
      messagesByContact.set(contactId, [...(messagesByContact.get(contactId) || []), message]);
      return fulfill(route, message, 201);
    }

    const deliveryMatch = path.match(/^\/api\/conversations\/(\d+)\/messages\/delivery-statuses$/);
    if (deliveryMatch && method === "POST") {
      return fulfill(route, []);
    }

    const takeoverMatch = path.match(/^\/api\/conversations\/(\d+)\/takeover$/);
    if (takeoverMatch && method === "POST") {
      const contactId = Number(takeoverMatch[1]);
      record(request);
      setConversationMode(contactId, "human");
      return fulfill(route, { ok: true });
    }

    const returnToAiMatch = path.match(/^\/api\/conversations\/(\d+)\/return-to-ai$/);
    if (returnToAiMatch && method === "POST") {
      const contactId = Number(returnToAiMatch[1]);
      record(request);
      setConversationMode(contactId, "ai");
      return fulfill(route, { ok: true });
    }

    if (path === "/api/contacts/paged" && method === "GET") {
      const search = String(url.searchParams.get("search") || "").trim().toLowerCase();
      const assignment = String(url.searchParams.get("assignment") || "all");
      const offset = Number(url.searchParams.get("offset") || "0");
      const limit = Number(url.searchParams.get("limit") || "60");
      let rows = contacts.filter(item =>
        !search || [item.name, item.whatsapp_profile_name,
          item.whatsapp_number, item.channel_user_id]
          .some(value => String(value || "").toLowerCase().includes(search))
      );
      if (assignment === "mine") {
        rows = rows.filter(item => item.lead_owner_username === authUser.username);
      } else if (assignment === "unassigned") {
        rows = rows.filter(item => !item.lead_owner_username);
      } else if (assignment.startsWith("owner:")) {
        rows = rows.filter(item =>
          item.lead_owner_username === assignment.slice("owner:".length));
      }
      rows = rows.sort((a, b) =>
        String(b.last_message_at || "").localeCompare(String(a.last_message_at || "")));
      const total = rows.length;
      const items = rows.slice(offset, offset + limit);
      const owners = contacts.filter(item => item.lead_owner_username)
        .map(item => ({
          lead_owner_username: item.lead_owner_username,
          lead_owner_display_name: item.lead_owner_display_name,
        }));
      return fulfill(route, {
        items, total, nextOffset: offset + items.length,
        hasMore: offset + items.length < total,
        ownerOptions: url.searchParams.get("includeOwners") === "true" ? owners : null,
      });
    }

    if (path === "/api/contacts" && method === "GET") {
      const search = String(url.searchParams.get("search") || "").trim().toLowerCase();
      const rows = search
        ? contacts.filter((item) =>
            [item.name, item.whatsapp_profile_name, item.whatsapp_number, item.channel_user_id]
              .some((value) => String(value || "").toLowerCase().includes(search))
          )
        : contacts;
      return fulfill(route, rows);
    }

    const contactInsightsMatch = path.match(/^\/api\/contacts\/(\d+)\/insights$/);
    if (contactInsightsMatch && method === "GET") {
      return fulfill(route, { lead: null, aiInsights: null });
    }

    const contactNotesMatch = path.match(/^\/api\/contacts\/(\d+)\/notes$/);
    if (contactNotesMatch && method === "GET") {
      return fulfill(route, []);
    }

    const deleteContactMatch = path.match(/^\/api\/contacts\/(\d+)$/);
    if (deleteContactMatch && method === "DELETE") {
      const contactId = Number(deleteContactMatch[1]);
      const body = request.postDataJSON();
      record(request, body);
      contacts = contacts.filter((item) => Number(item.id) !== contactId);
      conversations = conversations.filter((item) => Number(item.contact_id) !== contactId);
      pipeline = {
        ...pipeline,
        leads: pipeline.leads.filter((lead) => Number(lead.contact_id) !== contactId),
      };
      return fulfill(route, {
        purged: true,
        contactId,
        deletedCounts: { messages: 1, leads: 1, notes: 0 },
        mediaCleanupPending: false,
        deletedMediaObjects: 0,
      });
    }

    if (path === "/api/contacts/export" && method === "GET") {
      record(request);
      const search = String(url.searchParams.get("search") || "").trim().toLowerCase();
      const assignment = String(url.searchParams.get("assignment") || "all");
      const scope = String(url.searchParams.get("scope") || "current");
      let rows = [...contacts];

      if (scope === "current" && search) {
        rows = rows.filter((item) =>
          [item.name, item.whatsapp_profile_name, item.whatsapp_number, item.channel_user_id]
            .some((value) => String(value || "").toLowerCase().includes(search))
        );
      }
      if (scope === "current" && assignment === "mine") {
        rows = rows.filter((item) => item.lead_owner_username === STAFF_USER.username);
      } else if (scope === "current" && assignment === "unassigned") {
        rows = rows.filter((item) => !item.lead_owner_username);
      } else if (scope === "current" && assignment.startsWith("owner:")) {
        rows = rows.filter((item) => item.lead_owner_username === assignment.slice("owner:".length));
      }

      const csv = [
        '"Customer Name","Channel","Platform Customer ID","WhatsApp Number"',
        ...rows.map((item) =>
          `"${item.name || item.whatsapp_profile_name || ""}","WhatsApp","=""${item.whatsapp_number}""","=""${item.whatsapp_number}"""`
        ),
      ].join("\r\n");

      return route.fulfill({
        status: 200,
        contentType: "text/csv; charset=utf-8",
        headers: {
          "Content-Disposition": 'attachment; filename="customers-list-2026-09-30.csv"',
          "X-Export-Row-Count": String(rows.length),
          "Cache-Control": "no-store",
        },
        body: `\uFEFF${csv}`,
      });
    }

    if (path === "/api/pipeline" && method === "GET") {
      return fulfill(route, pipeline);
    }

    if (path === "/api/pipeline/configured-branches" && method === "GET") {
      return fulfill(route, pipeline.branches || []);
    }

    const voucherMatch = path.match(/^\/api\/pipeline\/leads\/(\d+)\/assessment-voucher$/);
    if (voucherMatch && method === "GET") return fulfill(route, voucher);
    if (voucherMatch && method === "POST") {
      const body = request.postDataJSON();
      record(request, body);
      if (voucherWriteError) return fulfill(route, {error:"Voucher state changed, reload this lead."}, 409);
      voucher = { ...voucher, status: body.status, valueRm: 100, updatedBy: authUser.username,
        ...(body.status === "issued" ? {termsNote:body.termsNote, expiresAt:body.expiresAt || null} : {}),
        ...(body.status === "redeemed" ? {redemptionNote:body.redemptionNote} : {}) };
      voucherActivities = [{id:voucherActivities.length+1,description:"Voucher status updated to "+body.status,actor:authUser.username,
        created_at:new Date().toISOString()},...voucherActivities];
      return fulfill(route, voucher);
    }
    const activitiesMatch = path.match(/^\/api\/pipeline\/leads\/(\d+)\/activities$/);
    if (activitiesMatch && method === "GET") return fulfill(route, voucherActivities);
    const leadMatch = path.match(/^\/api\/pipeline\/leads\/(\d+)$/);
    if (leadMatch && method === "PATCH") {
      const leadId = Number(leadMatch[1]);
      const body = request.postDataJSON();
      record(request, body);
      let updated = null;
      pipeline = {
        ...pipeline,
        leads: pipeline.leads.map((lead) => {
          if (Number(lead.id) !== leadId) return lead;
          updated = {
            ...lead,
            ...(body.stageId != null ? { stage_id: Number(body.stageId) } : {}),
            ...(body.lostReason !== undefined ? { lost_reason: body.lostReason } : {}),
            ...(body.estimatedValue !== undefined ? { estimated_value: body.estimatedValue } : {}),
            ...(body.appointmentStatus !== undefined ? { appointment_status: body.appointmentStatus } : {}),
            ...(body.treatmentInterest !== undefined ? { treatment_interest: body.treatmentInterest } : {}),
          };
          return updated;
        }),
      };
      return fulfill(route, updated);
    }

    const scheduledMatch = path.match(/^\/api\/conversations\/(\d+)\/scheduled-messages$/);
    if (scheduledMatch && method === "GET") {
      const contactId = Number(scheduledMatch[1]);
      const contact = conversations.find(
        (item) => Number(item.contact_id) === contactId
      );
      return fulfill(route, {
        items: [],
        lastInboundAt: contact?.latest_inbound_at || null,
        windowEndsAt: null,
        staffMode: contact?.mode === "human",
        channel: contact?.channel || "whatsapp",
        messagingAllowed: true,
        policyCode: null,
        policyMessage: "",
      });
    }

    unexpected.push({ method, path });
    return fulfill(route, { error: `Unexpected mocked API request: ${method} ${path}` }, 501);
  });

  return {
    calls,
    unexpected,
    getConversations: () => conversations,
    getPipeline: () => pipeline,
    getVoucher: () => voucher,
  };
}

function expectNoUnexpectedApi(apiState) {
  expect(apiState.unexpected, "All browser API calls should be explicitly mocked").toEqual([]);
}

function findCall(apiState, method, path) {
  return apiState.calls.find((call) => call.method === method && call.path === path);
}


async function openInboxConversation(page, name = "Alex Customer") {
  if ((page.viewportSize()?.width ?? 0) >= 1024) return;

  const inbox = page.getByRole("complementary", { name: "Conversation inbox" });
  const conversation = inbox.getByRole("button").filter({ hasText: name }).first();
  await expect(conversation).toBeVisible();
  await expect(conversation).toHaveAttribute("aria-current", "true");
  await conversation.click();
  await expect(
    page.locator(`section[aria-label="Conversation with ${name}"]`)
  ).toBeVisible();
}

test("recovery button choices render as read-only WhatsApp options on all screen sizes", async ({page}) => {
  const buttons = [
    {id: "neutro_131060_pelvic", title: "骨盆调理"},
    {id: "neutro_131060_3d", title: "3D 小颜术"},
    {id: "neutro_131060_9d", title: "9D 逆龄抗衰"},
  ];
  const apiState = await installApi(page, {
    initialMessages: [
      ...inboundMessages(),
      {
        id: 2, role: "assistant",
        created_at: recentIso(),
        content: "Hi～欢迎来到 Neutro Sense 😊\n\n想了解哪方面的护理呢？",
        whatsapp_message_id: "wamid.interactive-menu",
        delivery_status: "delivered",
        whatsapp_interactive: {type: "button", buttons},
      },
      {
        id: 3, role: "assistant",
        created_at: recentIso(),
        content: "普通文字回复", whatsapp_message_id: "wamid.plain-text",
        delivery_status: "delivered",
      },
    ],
  });
  await page.goto("/inbox");
  await openInboxConversation(page);
  const options = page.getByRole("group", {name: "WhatsApp reply options sent"});
  await expect(options).toHaveCount(1);
  for (const button of buttons) await expect(options.getByText(button.title, {exact:true})).toBeVisible();
  await expect(options.locator("button, a")).toHaveCount(0);
  await expect(page.getByText("普通文字回复")).toBeVisible();
  expectNoUnexpectedApi(apiState);
});

test("WhatsApp sender selection stays inside Filters on mobile and filters the list", async ({ page }, testInfo) => {
  const primary = conversation({
    contact_id: 101,
    whatsapp_sender_key: "neutro",
    whatsapp_sender_display_name: "Neutro Sense",
  });
  const secondary = conversation({
    contact_id: 202,
    name: "Bella Customer",
    whatsapp_profile_name: "Bella Customer",
    whatsapp_number: "+60199887766",
    whatsapp_sender_key: "neutro_secondary",
    whatsapp_sender_display_name: "中医养生馆",
  });
  const apiState = await installApi(page, {
    initialConversations: [primary, secondary],
  });
  await page.goto("/inbox");
  const list = page.getByRole("complementary", { name: "Conversation inbox" });
  const panel = list.locator('[aria-label="Inbox filters"]');
  const filtersButton = list.getByRole("button", { name: /Filters/ });
  const sender = panel.getByRole("combobox", { name: "WhatsApp business number" });

  if (testInfo.project.name === "iphone-portrait") {
    // Business-number tabs must not occupy a second row below search.
    await expect(list.locator('div[aria-label="WhatsApp business number"]')).toHaveCount(0);
    await expect(sender).toBeHidden();
  }
  await filtersButton.click();
  await expect(sender).toBeVisible();
  await expect(sender.locator("option")).toHaveText(["All numbers", "DA", "中医养生馆"]);
  await sender.selectOption("neutro_secondary");
  await expect(list.getByRole("button").filter({ hasText: "Bella Customer" }).first()).toBeVisible();
  await expect(list.getByRole("button").filter({ hasText: "Alex Customer" })).toHaveCount(0);
  await expect(filtersButton).toContainText("1");
  if (testInfo.project.name === "iphone-portrait") {
    await filtersButton.click();
    await expect(panel).toBeHidden();
    await expect(list.getByRole("button", { name: /Number · 中医养生馆/ })).toBeHidden();
    await expect(sender).toBeHidden();
    await filtersButton.click();
  }
  await sender.selectOption("all");
  await expect(list.getByRole("button").filter({ hasText: "Alex Customer" }).first()).toBeVisible();
  await expect(list.getByRole("button").filter({ hasText: "Bella Customer" }).first()).toBeVisible();
  expectNoUnexpectedApi(apiState);
});

test("message action menus use SVG Reply Forward Copy icons, never text glyphs", async ({ page }, testInfo) => {
  const apiState = await installApi(page);
  await page.goto("/inbox");
  await openInboxConversation(page);
  await page.getByRole("button", { name: "Message actions" }).first().click();
  const menu = testInfo.project.name === "iphone-portrait"
    ? page.getByRole("menu", { name: "Message options" })
    : page.getByRole("menu").first();
  await expect(menu).toBeVisible();
  for (const label of ["Reply", "Forward", "Copy"]) {
    const action = menu.getByRole("menuitem", { name: new RegExp(label) });
    await expect(action).toBeVisible();
    await expect(action.locator("svg")).toHaveCount(1);
    expect((await action.innerText()).trim().startsWith(label)).toBe(true);
  }
  await menu.getByRole("menuitem", { name: /Copy/ }).click();
  await expect(menu).toBeHidden();
  expect(findCall(apiState, "POST", "/api/conversations/101/messages")).toBeFalsy();
  expectNoUnexpectedApi(apiState);
});

test("Archived joins the Status filter with a clean header and accurate active counts", async ({ page }, testInfo) => {
  const apiState = await installApi(page, {
    initialConversations: [
      conversation(),
      conversation({
        contact_id: 202, name: "Bella Customer", whatsapp_number: "+60199887766",
        inbox_archived_at: recentIso(), is_unread: true, needs_follow_up: true,
      }),
    ],
  });
  await page.goto("/inbox");
  const list = page.getByRole("complementary", { name: "Conversation inbox" });
  const header = list.locator(".wa-inbox-list-header");
  await expect(header.getByRole("button", { name: "Open archived chats" })).toHaveCount(0);
  await expect(header.getByRole("combobox", { name: "Chats" })).toHaveCount(0);
  await expect(list.getByRole("button").filter({ hasText: "Bella Customer" })).toHaveCount(0);
  // The default Inbox and unread/follow-up counters must not include archived chats.
  await list.getByRole("button", { name: /Filters/ }).click();
  const panel = list.locator("#inbox-filter-panel");
  const status = panel.getByRole("combobox", { name: "Status" });
  await expect(panel.locator("select").first()).toHaveAttribute("aria-label", "Status");
  await expect(panel.getByRole("combobox", { name: "Chats" })).toHaveCount(0);
  await expect(status).toContainText("Archived (1)");
  await expect(status).toContainText("Unread (0)");
  await expect(status).toContainText("Follow-up (0)");
  await status.selectOption("archived");
  // A status selection closes the large filter panel and shows chats immediately.
  await expect(panel).toHaveCount(0);
  await expect(list.getByRole("button").filter({ hasText: "Bella Customer" }).first()).toBeVisible();
  await expect(list.getByRole("button").filter({ hasText: "Alex Customer" })).toHaveCount(0);
  if (testInfo.project.name === "iphone-portrait") {
    const statusTabs = list.locator(".wa-inbox-status-tabs");
    const allTab = statusTabs.locator("button").filter({ hasText: /^All/ });
    const archivedTab = statusTabs.locator("button").filter({ hasText: /^Archived/ });
    await expect(archivedTab).toHaveAttribute("aria-pressed", "true");
    await allTab.click();
    await expect(list.getByRole("button").filter({ hasText: "Alex Customer" }).first()).toBeVisible();
    await archivedTab.scrollIntoViewIfNeeded();
    await archivedTab.click();
    await expect(list.getByRole("button").filter({ hasText: "Bella Customer" }).first()).toBeVisible();
  }
  await list.getByRole("button", { name: /Filters/ }).click();
  await panel.getByRole("combobox", { name: "Status" }).selectOption("all");
  await expect(list.getByRole("button").filter({ hasText: "Alex Customer" }).first()).toBeVisible();
  await expect(list.getByRole("button").filter({ hasText: "Bella Customer" })).toHaveCount(0);
  expect(findCall(apiState, "PATCH", "/api/conversations/202/archive")).toBeFalsy();
  expectNoUnexpectedApi(apiState);
});

test("restricted staff see only usable filters, not a non-editable Lead owner field", async ({ page }) => {
  await installApi(page, {
    authUser: {
      ...STAFF_USER,
      permissions: { ...STAFF_USER.permissions, view_all_leads: false, manage_assigned_leads: false },
    },
  });
  await page.goto("/inbox");
  const list = page.getByRole("complementary", { name: "Conversation inbox" });
  await list.getByRole("button", { name: /Filters/ }).click();
  const panel = list.locator("#inbox-filter-panel");
  await expect(panel.getByRole("combobox", { name: "Status" })).toBeVisible();
  await expect(panel.getByRole("combobox", { name: "Lead owner" })).toHaveCount(0);
  await expect(panel.getByText("My assigned leads")).toHaveCount(0);
});

test("swipe right reveals Archive, moves chat into Archived, and Unarchive restores it", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iphone-portrait", "Phone list gesture only.");
  const apiState = await installApi(page, {
    initialConversations: [
      conversation({ needs_follow_up: true, mode: "ai" }),
      conversation({ contact_id: 202, name: "Bella Customer", whatsapp_number: "+60199887766" }),
    ],
  });
  await page.goto("/inbox");
  const list = page.getByRole("complementary", { name: "Conversation inbox" });
  const row = list.getByRole("button").filter({ hasText: "Alex Customer" }).first();
  await expect(row).toBeVisible();
  const wrap = row.locator("xpath=..").locator("xpath=..");
  await wrap.evaluate((element) => {
    const point = (x, y) => ({ identifier: 1, target: element, clientX: x, clientY: y, screenX: x, screenY: y });
    const fire = (type, touches) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "touches", { value: touches });
      Object.defineProperty(ev, "changedTouches", { value: touches });
      element.dispatchEvent(ev);
    };
    fire("touchstart", [point(55, 180)]);
    fire("touchmove", [point(145, 182)]);
    fire("touchend", []);
  });
  const archive = list.locator(".wa-archive-row").filter({ hasText: "Alex Customer" }).getByRole("button", { name: "Archive chat" });
  await expect(archive).toBeVisible();
  await archive.click();
  await expect(list.getByRole("button").filter({ hasText: "Alex Customer" })).toHaveCount(0);
  const sent = findCall(apiState, "PATCH", "/api/conversations/101/archive");
  expect(sent?.body).toEqual({ archived: true });
  await expect(list.getByRole("button").filter({ hasText: "Bella Customer" }).first()).toBeVisible();
  // Search still finds archived conversations without unarchiving them.
  const search = list.getByRole("searchbox", { name: "Search by name, number, message, or assignee" });
  await search.fill("Alex Customer");
  await expect(list.getByRole("button").filter({ hasText: "Alex Customer" }).first()).toBeVisible();
  await expect(list.getByText("Archived", { exact: true }).first()).toBeVisible();
  await search.fill("");
  await expect(list.getByRole("button").filter({ hasText: "Alex Customer" })).toHaveCount(0);
  await list.getByRole("button", { name: /Filters/ }).click();
  await list.getByRole("combobox", { name: "Status" }).selectOption("archived");
  await expect(list.getByRole("button").filter({ hasText: "Alex Customer" }).first()).toBeVisible();
  await expect(list.locator(".wa-archive-row").filter({ hasText: "Alex Customer" })
    .getByRole("button", { name: "Unarchive chat" })).toHaveCount(1);
  // The archived action is hidden until the row is swiped right.
  await list.locator(".wa-archive-row").filter({ hasText: "Alex Customer" }).getByRole("button", { name: "Unarchive chat" }).evaluate((element) => {
    const wrap = element.closest(".wa-archive-row");
    const point = (x, y) => ({ identifier: 2, target: wrap, clientX: x, clientY: y, screenX: x, screenY: y });
    const fire = (type, touches) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "touches", { value: touches });
      wrap.dispatchEvent(ev);
    };
    fire("touchstart", [point(50, 180)]);
    fire("touchmove", [point(140, 182)]);
    fire("touchend", []);
  });
  await list.locator(".wa-archive-row").filter({ hasText: "Alex Customer" }).getByRole("button", { name: "Unarchive chat" }).click();
  const allCalls = apiState.calls.filter((c) => c.path === "/api/conversations/101/archive");
  expect(allCalls.map((c) => c.body.archived)).toEqual([true, false]);
  await list.getByRole("button", { name: /Filters/ }).click();
  await list.getByRole("combobox", { name: "Status" }).selectOption("all");
  await expect(list.getByRole("button").filter({ hasText: "Alex Customer" }).first()).toBeVisible();
  // Archive only affects display: follow-up and AI mode are untouched.
  expect(findCall(apiState, "POST", "/api/conversations/101/messages")).toBeFalsy();
  expectNoUnexpectedApi(apiState);
});

test("conversation actions archive and restore without changing AI ownership", async ({ page }) => {
  const apiState = await installApi(page);
  await page.goto("/inbox");
  await openInboxConversation(page);
  await page.getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Archive chat" }).click();
  expect(findCall(apiState, "PATCH", "/api/conversations/101/archive")?.body)
    .toEqual({ archived: true });
  const inboxList = page.getByRole("complementary", { name: "Conversation inbox" });
  // A successful mobile archive returns to the chat list asynchronously.
  await expect(inboxList).toBeVisible();
  await expect(inboxList.getByRole("button", { name: /Filters/ })).toBeVisible();
  await inboxList.getByRole("button", { name: /Filters/ }).click();
  await inboxList.getByRole("combobox", { name: "Status" }).selectOption("archived");
  const archivedRow = page.getByRole("complementary", { name: "Conversation inbox" })
    .getByRole("button").filter({ hasText: "Alex Customer" }).first();
  await expect(archivedRow).toBeVisible();
  await archivedRow.click();
  await page.getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Unarchive chat" }).click();
  const changes = apiState.calls.filter((c) => c.path === "/api/conversations/101/archive");
  expect(changes.map((c) => c.body.archived)).toEqual([true, false]);
  expect(findCall(apiState, "POST", "/api/conversations/101/return-to-ai")).toBeFalsy();
  expectNoUnexpectedApi(apiState);
});

test("read-only staff cannot see or swipe to Archive", async ({ page }, testInfo) => {
  const apiState = await installApi(page, {
    authUser: {
      ...STAFF_USER,
      permissions: { ...STAFF_USER.permissions, manage_assigned_leads: false },
    },
  });
  await page.goto("/inbox");
  const list = page.getByRole("complementary", { name: "Conversation inbox" });
  const row = list.getByRole("button").filter({ hasText: "Alex Customer" }).first();
  await expect(row).toBeVisible();
  if (testInfo.project.name === "iphone-portrait") {
    const wrap = list.locator(".wa-archive-row").filter({ hasText: "Alex Customer" });
    await wrap.evaluate((element) => {
      const point = (x, y) => ({ identifier: 3, target: element, clientX: x, clientY: y, screenX: x, screenY: y });
      for (const [type, touches] of [
        ["touchstart", [point(35, 180)]],
        ["touchmove", [point(155, 180)]],
        ["touchend", []],
      ]) {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "touches", { value: touches });
        element.dispatchEvent(ev);
      }
    });
    await expect(wrap.locator("div[style*='translateX']")).toHaveAttribute("style", /translateX\(0px\)/);
  }
  await expect(list.getByRole("button", { name: "Archive chat" })).toHaveCount(0);
  if (testInfo.project.name === "iphone-portrait") {
    // The swipe protection intentionally ignores the immediate synthetic tap.
    await page.waitForTimeout(350);
  }
  await openInboxConversation(page);
  const actionsButton = page.getByRole("button", { name: "Conversation actions" });
  // Some read-only layouts omit the actions menu entirely.
  if (await actionsButton.isVisible()) {
    await actionsButton.click();
    await expect(page.getByRole("menuitem", { name: "Archive chat" })).toHaveCount(0);
  }
  expect(findCall(apiState, "PATCH", "/api/conversations/101/archive")).toBeFalsy();
  expectNoUnexpectedApi(apiState);
});

test("failed Archive restores the open thread, deep link, and original chat state", async ({ page }) => {
  const apiState = await installApi(page, {
    archiveWriteError: true,
    initialConversations: [conversation({ inbox_archived_at: null, mode: "ai", needs_follow_up: true })],
  });
  await page.goto("/inbox?contact=101");
  await expect(page.getByRole("button", { name: "Conversation actions" })).toBeVisible();
  await page.getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Archive chat" }).click();
  await expect(page.getByText("Couldn't update archive. Please try again.")).toBeVisible();
  await expect(page).toHaveURL(/contact=101/);
  await expect(page.getByRole("button", { name: "Conversation actions" })).toBeVisible();
  await page.getByRole("button", { name: "Conversation actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Archive chat" })).toBeVisible();
  expect(findCall(apiState, "PATCH", "/api/conversations/101/archive")?.body).toEqual({ archived: true });
  expect(findCall(apiState, "POST", "/api/conversations/101/messages")).toBeFalsy();
  expect(findCall(apiState, "POST", "/api/conversations/101/return-to-ai")).toBeFalsy();
  expectNoUnexpectedApi(apiState);
});

test("Inbox message actions are mobile-friendly and preserve quoted reply targets", async ({ page }, testInfo) => {
  const secondConversation = conversation({
    contact_id: 202,
    name: "Bella Customer",
    whatsapp_profile_name: "Bella Customer",
    whatsapp_number: "+60199887766",
    last_message_content: "Bella enquiry",
  });
  const apiState = await installApi(page, {
    initialConversations: [conversation(), secondConversation],
  });

  await page.goto("/inbox");
  await openInboxConversation(page);

  const actionsButton = page.getByRole("button", { name: "Message actions" }).first();
  await expect(actionsButton).toBeVisible();

  if (testInfo.project.name === "iphone-portrait") {
    const target = await actionsButton.boundingBox();
    expect(target).not.toBeNull();
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
  }

  await actionsButton.click();

  if (testInfo.project.name === "iphone-portrait") {
    const sheet = page.getByRole("menu", { name: "Message options" });
    await expect(sheet).toBeVisible();
    const viewport = page.viewportSize();
    const box = await sheet.boundingBox();
    const bubble = await actionsButton.locator("xpath=../..").boundingBox();
    expect(viewport).not.toBeNull();
    expect(box).not.toBeNull();
    expect(bubble).not.toBeNull();
    await expect(sheet).toHaveAttribute("data-menu-placement", "anchored");
    // WhatsApp-style contextual popup, not an edge-to-edge bottom sheet.
    expect(box.width).toBeLessThan(viewport.width - 20);
    expect(box.x).toBeGreaterThanOrEqual(10);
    expect(box.y).toBeGreaterThanOrEqual(10);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 10);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 8);
    expect(Math.abs(box.x - bubble.x)).toBeLessThanOrEqual(28);
    const closeOverlay = page.getByRole("button", { name: "Close message actions" });
    await expect(closeOverlay).toHaveCSS("clip-path", /polygon\(evenodd/);
    const spotlight = page.locator('[data-selected-message-spotlight]');
    await expect(spotlight).toBeVisible();
    const before = await spotlight.boundingBox();
    expect(before).not.toBeNull();
    expect(Math.abs(before.x - bubble.x)).toBeLessThanOrEqual(5);
    expect(Math.abs(before.height - bubble.height)).toBeLessThanOrEqual(10);

    const replyAction = sheet.getByRole("menuitem", { name: /Reply/ });
    const replyBox = await replyAction.boundingBox();
    expect(replyBox).not.toBeNull();
    expect(replyBox.height).toBeGreaterThanOrEqual(48);
    await replyAction.click();
  } else {
    await page.getByRole("menuitem", { name: /Reply/ }).click();
  }

  await expect(page.getByText(/Replying to/i)).toBeVisible();
  const composer = page.locator("textarea").first();
  await composer.fill("Quoted reply from staff");
  await page.getByRole("button", { name: "Send message" }).click();

  const replyCall = findCall(apiState, "POST", "/api/conversations/101/messages");
  expect(replyCall).toBeTruthy();
  expect(replyCall.body.replyToMessageId).toBe(1);

  await actionsButton.click();
  const forwardAction = page.getByRole("menuitem", { name: /Forward/ });
  await forwardAction.click();

  const dialog = page.getByRole("dialog", { name: "Forward message" });
  await expect(dialog).toBeVisible();
  const search = dialog.getByRole("textbox", { name: "Search conversations to forward" });

  if (testInfo.project.name === "iphone-portrait") {
    const viewport = page.viewportSize();
    const box = await dialog.locator("> div").boundingBox();
    expect(viewport).not.toBeNull();
    expect(box).not.toBeNull();
    expect(Math.abs(box.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.width - viewport.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y + box.height - viewport.height)).toBeLessThanOrEqual(2);
    expect(await search.evaluate((element) => document.activeElement === element)).toBe(false);
  }

  await dialog.getByRole("button").filter({ hasText: "Bella Customer" }).click();
  await dialog.getByRole("button", { name: "Forward (1)" }).click();

  const forwardCall = findCall(
    apiState,
    "POST",
    "/api/conversations/101/messages/1/forward"
  );
  expect(forwardCall).toBeTruthy();
  expect(forwardCall.body.targetContactIds).toEqual([202]);
  expectNoUnexpectedApi(apiState);
});

test("mobile swipe right starts a quoted reply", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iphone-portrait", "Swipe gesture is a phone interaction.");

  const apiState = await installApi(page);
  await page.goto("/inbox");
  await openInboxConversation(page);

  const actionsButton = page.getByRole("button", { name: "Message actions" }).first();
  const bubble = actionsButton.locator("xpath=../..");
  await bubble.evaluate((element) => {
    const point = (x, y) => ({
      identifier: 1,
      target: element,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      pageX: x,
      pageY: y,
    });
    const dispatchTouch = (type, touches, changedTouches = touches) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: touches });
      Object.defineProperty(event, "targetTouches", { value: touches });
      Object.defineProperty(event, "changedTouches", { value: changedTouches });
      element.dispatchEvent(event);
    };

    dispatchTouch("touchstart", [point(40, 160)]);
    dispatchTouch("touchmove", [point(120, 162)]);
    dispatchTouch("touchend", [], [point(120, 162)]);
  });

  await expect(page.getByText(/Replying to/i)).toBeVisible();
  expectNoUnexpectedApi(apiState);
});

test("mobile long press opens the WhatsApp-style message actions without sending anything", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iphone-portrait", "Long press is a phone interaction.");

  const apiState = await installApi(page);
  await page.goto("/inbox");
  await openInboxConversation(page);

  const bubble = page.getByRole("button", { name: "Message actions" }).first().locator("xpath=../..");
  await bubble.evaluate(async (element) => {
    const point = (x, y) => ({
      identifier: 1,
      target: element,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      pageX: x,
      pageY: y,
    });
    const dispatch = (type, touches, changedTouches = touches) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: touches });
      Object.defineProperty(event, "targetTouches", { value: touches });
      Object.defineProperty(event, "changedTouches", { value: changedTouches });
      element.dispatchEvent(event);
    };
    dispatch("touchstart", [point(40, 160)]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    dispatch("touchend", [], [point(40, 160)]);
  });

  const menu = page.getByRole("menu", { name: "Message options" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Reply/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Forward/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Copy/ })).toBeVisible();
  await expect(menu).toHaveAttribute("data-menu-placement", "anchored");
  const bubbleBox = await bubble.boundingBox();
  const menuBox = await menu.boundingBox();
  expect(bubbleBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(menuBox.width).toBeLessThan(page.viewportSize().width - 20);
  expect(menuBox.y).toBeGreaterThanOrEqual(10);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(page.viewportSize().height - 8);

  await menu.getByRole("menuitem", { name: /Reply/ }).click();
  await expect(page.getByText(/Replying to/i)).toBeVisible();
  expect(findCall(apiState, "POST", "/api/conversations/101/messages")).toBeFalsy();
  expectNoUnexpectedApi(apiState);
});

test("iPhone message menu responds to keyboard navigation and Escape without sending", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iphone-portrait", "Mobile floating actions only.");
  const apiState = await installApi(page);
  await page.goto("/inbox");
  await openInboxConversation(page);
  const trigger = page.getByRole("button", { name: "Message actions" }).first();
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Message options" });
  await expect(menu).toBeVisible();
  const reply = menu.getByRole("menuitem", { name: /Reply/ });
  const forward = menu.getByRole("menuitem", { name: /Forward/ });
  const copy = menu.getByRole("menuitem", { name: /Copy/ });
  await expect(reply).toBeFocused();
  await page.keyboard.press("End");
  await expect(copy).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(forward).toBeFocused();
  await page.keyboard.press("Home");
  await expect(reply).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(findCall(apiState, "POST", "/api/conversations/101/messages")).toBeFalsy();
  expectNoUnexpectedApi(apiState);
});

test("floating action menu keeps the selected bubble highlighted after its layout changes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iphone-portrait", "Mobile spotlight and observer only.");
  const apiState = await installApi(page);
  await page.goto("/inbox");
  await openInboxConversation(page);
  const bubble = page.getByRole("button", { name: "Message actions" }).first().locator("xpath=../..");
  await bubble.getByRole("button", { name: "Message actions" }).click();
  const menu = page.getByRole("menu", { name: "Message options" });
  const spotlight = page.locator("[data-selected-message-spotlight]");
  await expect(menu).toBeVisible();
  const before = await spotlight.boundingBox();
  // The repositioning calculation reads getBoundingClientRect(). Simulate
  // a media-driven geometry change directly, since WebKit may scroll-anchor
  // or clip a real oversized bubble when the test viewport is small.
  // A class mutation exercises the event-driven observer without polling.
  await bubble.evaluate((element) => {
    const originalRect = element.getBoundingClientRect.bind(element);
    element.getBoundingClientRect = () => {
      const rect = originalRect();
      return new DOMRect(rect.x + 26, rect.y, rect.width, rect.height + 120);
    };
    element.classList.add("test-bubble-media-layout-change");
    window.dispatchEvent(new Event("resize"));
  });
  await expect.poll(async () => (await spotlight.boundingBox())?.x)
    .toBeGreaterThan(before.x + 18);
  const after = await spotlight.boundingBox();
  expect(Math.abs(after.x - (before.x + 26))).toBeLessThanOrEqual(5);
  expect(after.height).toBeGreaterThan(before.height);
  const menuBox = await menu.boundingBox();
  expect(menuBox.x).toBeGreaterThanOrEqual(8);
  expect(menuBox.y).toBeGreaterThanOrEqual(8);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(page.viewportSize().height - 8);
  expectNoUnexpectedApi(apiState);
});

test("holding a document opens message actions without changing its download link", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iphone-portrait", "Phone document long press.");
  const apiState = await installApi(page, {
    initialMessages: [{
      ...inboundMessages()[0], id: 1, content: "Document attached",
      media_mime_type: "application/pdf", media_filename: "Terms.pdf",
      media_base64: "SGVsbG8=", has_media_attachment: true,
    }],
  });
  await page.goto("/inbox");
  await openInboxConversation(page);
  const doc = page.getByRole("link", { name: /Terms.pdf/ });
  await expect(doc).toHaveAttribute("href", /^data:application\/pdf;base64,/);
  await doc.evaluate(async (element) => {
    const touch = { identifier: 3, target: element, clientX: 100, clientY: 200, screenX: 100, screenY: 200 };
    const dispatch = (type, touches) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: touches });
      Object.defineProperty(event, "changedTouches", { value: touches });
      element.dispatchEvent(event);
    };
    dispatch("touchstart", [touch]);
    await new Promise(resolve => setTimeout(resolve, 500));
    dispatch("touchend", []);
  });
  const menu = page.getByRole("menu", { name: "Message options" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Forward/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Reply/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(doc).toHaveAttribute("href", /^data:application\/pdf;base64,/);
  expectNoUnexpectedApi(apiState);
});

test("audio message controls remain available alongside their actions button", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iphone-portrait", "Mobile native voice player.");
  const apiState = await installApi(page, {
    initialMessages: [{
      ...inboundMessages()[0], id: 1, content: "Voice note",
      media_mime_type: "audio/ogg", media_base64: "T2dnUw==",
      has_media_attachment: true,
    }],
  });
  await page.goto("/inbox");
  await openInboxConversation(page);
  const audio = page.locator(".wa-message-bubble audio");
  await expect(audio).toBeVisible();
  await expect(audio).toHaveAttribute("controls", "");
  const button = page.getByRole("button", { name: "Message actions" }).first();
  await button.click();
  await expect(page.getByRole("menu", { name: "Message options" })).toBeVisible();
  await expect(audio).toBeVisible();
  expectNoUnexpectedApi(apiState);
});

test("closed source WhatsApp chat shows Reply unavailable, Forward and Copy", async ({ page }) => {
  const expiredInbound = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  const apiState = await installApi(page, {
    initialConversations: [conversation({
      latest_inbound_at: expiredInbound,
      latest_customer_message_at: expiredInbound,
      last_message_at: expiredInbound,
    })],
  });

  await page.goto("/inbox");
  await openInboxConversation(page);
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await page.getByRole("button", { name: "Message actions" }).first().click();

  const menu = page.getByRole("menu", {
    name: page.viewportSize().width < 640 ? "Message options" : undefined,
  });
  const copy = menu.getByRole("menuitem", { name: /Copy/ });
  await expect(copy).toBeVisible();
  const reply = menu.getByRole("menuitem", { name: /Reply/ });
  const forward = menu.getByRole("menuitem", { name: /Forward/ });
  await expect(reply).toBeVisible();
  await expect(reply).toBeDisabled();
  await expect(forward).toBeVisible();
  await expect(forward).toBeEnabled();
  if (page.viewportSize().width < 640) {
    // A visible React element can still be clipped by the message scroller
    // or hidden behind the composer on real phones. Check actual hit testing.
    await expect(copy).toBeInViewport({ ratio: 0.99 });
    const sheetIsAboveComposer = await copy.evaluate((button) => {
      const menuElement = button.closest('[aria-label="Message options"]');
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return menuElement?.parentElement === document.body &&
        Boolean(hit && (button === hit || button.contains(hit)));
    });
    expect(sheetIsAboveComposer).toBe(true);
    await copy.click();
    await expect(menu).toBeHidden();
  }
  expect(findCall(apiState, "POST", "/api/conversations/101/messages/1/forward")).toBeFalsy();
  expectNoUnexpectedApi(apiState);
});

test("suspended secondary WhatsApp number cannot forward from the message actions", async ({ page }) => {
  const apiState = await installApi(page, {
    initialConversations: [conversation({
      whatsapp_is_secondary: true,
      whatsapp_sender_state: "suspended",
      whatsapp_sender_coexistence_enabled: false,
    })],
  });

  await page.goto("/inbox");
  await openInboxConversation(page);
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await page.getByRole("button", { name: "Message actions" }).first().click();
  await expect(page.getByRole("menuitem", { name: /Copy/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Forward/ })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: /Reply/ })).toBeDisabled();
  expectNoUnexpectedApi(apiState);
});

test("forwarding from a closed source sends only to an eligible target in the same business", async ({ page }) => {
  const closedAt = new Date(Date.now() - 27 * 60 * 60 * 1000).toISOString();
  const closedSource = conversation({
    latest_inbound_at: closedAt,
    latest_customer_message_at: closedAt,
    last_message_at: closedAt,
    whatsapp_sender_id: "same-business",
  });
  const openTarget = conversation({
    contact_id: 202,
    name: "Bella Customer",
    whatsapp_profile_name: "Bella Customer",
    whatsapp_number: "+60199887766",
    whatsapp_sender_id: "same-business",
  });
  const closedTarget = conversation({
    contact_id: 303,
    name: "Carol Customer",
    whatsapp_profile_name: "Carol Customer",
    whatsapp_number: "+60199883344",
    whatsapp_sender_id: "same-business",
    latest_inbound_at: closedAt,
    latest_customer_message_at: closedAt,
    last_message_at: closedAt,
  });
  const differentSenderTarget = conversation({
    contact_id: 404,
    name: "Other business contact",
    whatsapp_profile_name: "Other business contact",
    whatsapp_sender_id: "different-business",
  });
  const apiState = await installApi(page, {
    initialConversations: [closedSource, openTarget, closedTarget, differentSenderTarget],
  });

  await page.goto("/inbox");
  await openInboxConversation(page);
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await page.getByRole("button", { name: "Message actions" }).first().click();
  const menu = page.getByRole("menu", {
    name: (page.viewportSize()?.width ?? 1000) < 640 ? "Message options" : undefined,
  });
  await expect(menu.getByRole("menuitem", { name: /Reply/ })).toBeDisabled();
  await menu.getByRole("menuitem", { name: /Forward/ }).click();

  const dialog = page.getByRole("dialog", { name: "Forward message" });
  const bella = dialog.getByRole("button").filter({ hasText: "Bella Customer" });
  const carol = dialog.getByRole("button").filter({ hasText: "Carol Customer" });
  await expect(bella).toBeEnabled();
  await expect(carol).toBeDisabled();
  await expect(carol).toContainText(/must message|window|reply/i);
  await expect(dialog.getByText("Other business contact")).toHaveCount(0);

  await bella.click();
  await dialog.getByRole("button", { name: "Forward (1)" }).click();
  const sent = findCall(apiState, "POST", "/api/conversations/101/messages/1/forward");
  expect(sent?.body?.targetContactIds).toEqual([202]);
  expect(findCall(apiState, "POST", "/api/conversations/101/messages")).toBeFalsy();
  expectNoUnexpectedApi(apiState);
});

// Both sender rows belong to Neutro, but they remain distinct WhatsApp
// identities. The picker must not offer customers of another business.
for (const direction of ["primary-to-secondary", "secondary-to-primary"]) {
  test(`Neutro forwarding picker offers ${direction} without showing other senders`, async ({ page }) => {
    const primary = {
      whatsapp_sender_id: 1,
      whatsapp_sender_key: "neutro",
      whatsapp_sender_phone_number_id: "1408739622311791",
      whatsapp_sender_account_id: "1593376338308612",
      whatsapp_is_secondary: false,
    };
    const secondary = {
      whatsapp_sender_id: 2,
      whatsapp_sender_key: "neutro_secondary",
      whatsapp_sender_phone_number_id: "1318355951360575",
      whatsapp_sender_account_id: "1852014482431209",
      whatsapp_sender_state: "active",
      whatsapp_sender_coexistence_enabled: true,
      whatsapp_is_secondary: true,
    };
    const from = direction === "primary-to-secondary" ? primary : secondary;
    const to = direction === "primary-to-secondary" ? secondary : primary;
    const targetName = direction === "primary-to-secondary" ? "Secondary Patient" : "Primary Patient";
    const apiState = await installApi(page, {
      initialConversations: [
        conversation({ ...from }),
        conversation({ ...to, contact_id: 202, name: targetName, whatsapp_profile_name: targetName,
          whatsapp_number: "+60199887766" }),
        conversation({ contact_id: 303, name: "Outside Business", whatsapp_profile_name: "Outside Business",
          whatsapp_number: "+60199883344", whatsapp_sender_id: 3, whatsapp_sender_key: "other" }),
      ],
    });

    await page.goto("/inbox");
    await openInboxConversation(page);
    await page.getByRole("button", { name: "Message actions" }).first().click();
    await page.getByRole("menuitem", { name: /Forward/ }).click();
    const picker = page.getByRole("dialog", { name: "Forward message" });
    const target = picker.getByRole("button").filter({ hasText: targetName });
    await expect(target).toBeEnabled();
    await expect(target).toContainText(direction === "primary-to-secondary" ? "Secondary WhatsApp" : "Primary WhatsApp");
    await expect(picker.getByText("Outside Business")).toHaveCount(0);
    await target.click();
    await picker.getByRole("button", { name: "Forward (1)" }).click();
    const sent = findCall(apiState, "POST", "/api/conversations/101/messages/1/forward");
    expect(sent?.body?.targetContactIds).toEqual([202]);
    expectNoUnexpectedApi(apiState);
  });
}

test("iPhone hold on message text opens actions without selecting text", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iphone-portrait", "iPhone-specific long press interaction.");
  const closedAt = new Date(Date.now() - 27 * 60 * 60 * 1000).toISOString();
  const apiState = await installApi(page, {
    initialConversations: [conversation({
      latest_inbound_at: closedAt,
      latest_customer_message_at: closedAt,
      last_message_at: closedAt,
    })],
  });
  await page.goto("/inbox");
  await openInboxConversation(page);
  const content = page.getByText("Hi, I would like to know more.", { exact: true }).last();
  await expect(content).toBeVisible();
  // Exercise the actual gesture on message text. Safari's computed CSS
  // aliases differ across WebKit versions, so behavior matters more here.
  await content.evaluate(async (element) => {
    const point = (x, y) => ({
      identifier: 2, target: element, clientX: x, clientY: y,
      screenX: x, screenY: y, pageX: x, pageY: y,
    });
    const fire = (type, touches) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: touches });
      Object.defineProperty(event, "changedTouches", { value: touches });
      element.dispatchEvent(event);
    };
    fire("touchstart", [point(100, 180)]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    fire("touchend", []);
  });
  const sheet = page.getByRole("menu", { name: "Message options" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("menuitem", { name: /Reply/ })).toBeDisabled();
  await expect(sheet.getByRole("menuitem", { name: /Forward/ })).toBeEnabled();
  await expect(sheet.getByRole("menuitem", { name: /Copy/ })).toBeEnabled();
  expect(findCall(apiState, "POST", "/api/conversations/101/messages")).toBeFalsy();
  expectNoUnexpectedApi(apiState);
});

test("closed WhatsApp reply placeholder stays on one line on a phone", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iphone-portrait", "Mobile-specific composer layout.");
  const closedAt = new Date(Date.now() - 27 * 60 * 60 * 1000).toISOString();
  const apiState = await installApi(page, {
    initialConversations: [conversation({
      latest_inbound_at: closedAt,
      latest_customer_message_at: closedAt,
      last_message_at: closedAt,
    })],
  });
  await page.goto("/inbox");
  await openInboxConversation(page);
  const composer = page.locator("textarea").first();
  await expect(composer).toBeDisabled();
  await expect(composer).toHaveAttribute("placeholder", "Reply unavailable");
  await expect(composer).toHaveAttribute("aria-label", "WhatsApp reply unavailable");
  // WebKit forces pre-wrap on textarea placeholders despite ::placeholder CSS.
  // Check the shortened label actually fits the available single line instead.
  const size = await composer.evaluate((el) => {
    const style = getComputedStyle(el);
    const probe = document.createElement("canvas").getContext("2d");
    probe.font = style.font;
    return {
      text: probe.measureText(el.getAttribute("placeholder")).width,
      available: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    };
  });
  expect(size.text).toBeLessThan(size.available);
  expectNoUnexpectedApi(apiState);
});

test("an unfinished Inbox draft is isolated per contact and cleared only when sent", async ({ page }) => {
  const bella = conversation({
    contact_id: 202,
    name: "Bella Customer",
    whatsapp_profile_name: "Bella Customer",
    whatsapp_number: "+60199887766",
    last_message_content: "Question from Bella",
  });
  const apiState = await installApi(page, {
    initialConversations: [conversation(), bella],
  });

  await page.goto("/inbox");

  async function selectContact(name) {
    const thread = page.locator(`section[aria-label="Conversation with ${name}"]`);
    if ((page.viewportSize()?.width ?? 0) < 1024) {
      const back = page.getByRole("button", { name: "Back to conversations" });
      if (await back.isVisible()) await back.click();
    }
    const list = page.getByRole("complementary", { name: "Conversation inbox" });
    await list.getByRole("button").filter({ hasText: name }).first().click();
    await expect(thread).toBeVisible();
    return thread.locator("textarea").first();
  }

  const alexComposer = await selectContact("Alex Customer");
  await alexComposer.fill("Unsent Alex draft");
  const bellaComposer = await selectContact("Bella Customer");
  await bellaComposer.fill("Unsent Bella draft");
  const alexAgain = await selectContact("Alex Customer");
  await expect(alexAgain).toHaveValue("Unsent Alex draft");
  const bellaAgain = await selectContact("Bella Customer");
  await expect(bellaAgain).toHaveValue("Unsent Bella draft");

  await page.getByRole("button", { name: "Send message" }).click();
  await expect(bellaAgain).toHaveValue("");
  expect(findCall(apiState, "POST", "/api/conversations/202/messages")?.body?.text).toBe("Unsent Bella draft");

  const alexAfterBellaSend = await selectContact("Alex Customer");
  await expect(alexAfterBellaSend).toHaveValue("Unsent Alex draft");
  expect(findCall(apiState, "POST", "/api/conversations/101/messages")).toBeFalsy();
  expectNoUnexpectedApi(apiState);
});

test("phone Return adds a line without sending and mobile controls are easy to tap", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iphone-portrait", "Phone-only keyboard and touch checks.");
  const apiState = await installApi(page);
  await page.goto("/inbox");

  const search = page.getByRole("searchbox", { name: "Search by name, number, message, or assignee" });
  const searchFont = await search.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
  expect(searchFont).toBeGreaterThanOrEqual(16);

  await search.fill("Alex");
  const clear = page.getByRole("button", { name: "Clear search" });
  const clearSize = await clear.boundingBox();
  expect(clearSize.width).toBeGreaterThanOrEqual(44);
  expect(clearSize.height).toBeGreaterThanOrEqual(44);
  await clear.click();

  await openInboxConversation(page);
  for (const accessibleName of [
    "Back to conversations",
    "Open details for Alex Customer",
    "Take over conversation",
    "Conversation actions",
  ]) {
    const button = page.getByRole("button", { name: accessibleName }).first();
    const rect = await button.boundingBox();
    expect(rect, accessibleName).not.toBeNull();
    expect(rect.width, accessibleName).toBeGreaterThanOrEqual(44);
    expect(rect.height, accessibleName).toBeGreaterThanOrEqual(44);
  }

  const composer = page.locator("textarea").first();
  await composer.fill("First line");
  await composer.press("Enter");
  await composer.type("Second line");
  await expect(composer).toHaveValue("First line\nSecond line");
  expect(findCall(apiState, "POST", "/api/conversations/101/messages")).toBeFalsy();

  await page.getByRole("button", { name: "Send message" }).click();
  expect(findCall(apiState, "POST", "/api/conversations/101/messages")?.body?.text)
    .toBe("First line\nSecond line");
  expectNoUnexpectedApi(apiState);
});

test("desktop Enter sends but Enter during IME composition never sends", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Physical keyboard check on desktop.");
  const apiState = await installApi(page);
  await page.goto("/inbox");
  await openInboxConversation(page);
  const composer = page.locator("textarea").first();
  await composer.fill("Multilingual draft");
  await composer.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true, isComposing: true,
    }));
  });
  expect(findCall(apiState, "POST", "/api/conversations/101/messages")).toBeFalsy();
  await composer.press("Enter");
  expect(findCall(apiState, "POST", "/api/conversations/101/messages")?.body?.text)
    .toBe("Multilingual draft");
  expectNoUnexpectedApi(apiState);
});

test("login submits credentials and reaches Inbox", async ({ page }) => {
  const apiState = await installApi(page, { loggedIn: false });

  await page.goto("/login");
  await page.getByLabel("Username").fill("sales-test");
  await page.locator("#password").fill("secret-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByText("Alex Customer", { exact: true }).first()).toBeVisible();

  expect(findCall(apiState, "POST", "/api/auth/login")?.body).toEqual({
    username: "sales-test",
    password: "secret-password",
  });
  expectNoUnexpectedApi(apiState);
});

test("Contacts export waits for the current search and downloads the filtered CSV", async ({ page }, testInfo) => {
  const apiState = await installApi(page, {
    initialContacts: [
      contactFixture(),
      contactFixture({
        id: 102,
        name: "Bella Customer",
        whatsapp_profile_name: "Bella Customer",
        whatsapp_number: "60129876543",
        channel_user_id: "60129876543",
        lead_owner_username: null,
        lead_owner_display_name: null,
      }),
    ],
  });

  await page.goto("/contacts");

  const exportButton = page.getByRole("button", { name: "Export" });
  const search = page.getByPlaceholder("Search by name, number or social ID…");
  await expect(exportButton).toBeEnabled();

  await search.fill("Alex");
  await expect(exportButton).toBeDisabled();
  await expect(page.getByText("1 of 1 contact", { exact: true })).toBeVisible();
  await expect(exportButton).toBeEnabled();

  await exportButton.click();
  const dialog = page.getByRole("dialog", { name: "Export customer data" });
  await expect(dialog.getByText("Current view · 1", { exact: true })).toBeVisible();

  if (testInfo.project.name === "iphone-portrait") {
    const viewport = page.viewportSize();
    const box = await dialog.boundingBox();
    expect(viewport).not.toBeNull();
    expect(box).not.toBeNull();
    expect(Math.abs(box.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.width - viewport.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y + box.height - viewport.height)).toBeLessThanOrEqual(1);
  }

  const requestPromise = page.waitForRequest((request) =>
    new URL(request.url()).pathname === "/api/contacts/export"
  );
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export CSV" }).click();

  const [request, download] = await Promise.all([requestPromise, downloadPromise]);
  const exportUrl = new URL(request.url());
  expect(exportUrl.searchParams.get("scope")).toBe("current");
  expect(exportUrl.searchParams.get("preset")).toBe("customer");
  expect(exportUrl.searchParams.get("search")).toBe("Alex");
  expect(download.suggestedFilename()).toBe("customers-list-2026-09-30.csv");
  await expect(page.getByText("Exported 1 customer record.", { exact: true })).toBeVisible();

  expect(findCall(apiState, "GET", "/api/contacts/export")).toBeTruthy();
  expectNoUnexpectedApi(apiState);
});

test("Contacts permanent customer deletion requires typed confirmation", async ({ page }) => {
  const apiState = await installApi(page);

  await page.goto("/contacts");
  await page.getByText("Alex Customer", { exact: true }).first().click();

  const deleteButton = page.getByRole("button", { name: "Delete customer data" });
  await expect(deleteButton).toBeVisible();
  await deleteButton.click();

  const dialog = page.getByRole("dialog", { name: "Delete customer data" });
  const confirmButton = dialog.getByRole("button", { name: "Delete permanently" });
  await expect(confirmButton).toBeDisabled();

  await dialog.getByLabel("Type DELETE to confirm").fill("DELETE");
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText("Customer data permanently deleted.", { exact: true })).toBeVisible();

  const call = findCall(apiState, "DELETE", "/api/contacts/101");
  expect(call?.body).toEqual({ confirm: "DELETE" });
  expectNoUnexpectedApi(apiState);
});

test("older Inbox messages keep their sent time while the conversation list keeps the date", async ({ page }) => {
  const olderTimestamp = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  const apiState = await installApi(page, {
    initialConversations: [
      conversation({
        last_message_at: olderTimestamp,
        last_message_content: "Older timestamp test",
        latest_inbound_at: olderTimestamp,
        latest_customer_message_at: olderTimestamp,
      }),
    ],
    initialMessages: [
      {
        id: 1,
        role: "user",
        content: "Older timestamp test",
        created_at: olderTimestamp,
        media_url: null,
        media_base64: null,
        media_mime_type: null,
      },
    ],
  });

  await page.goto("/inbox");

  const { expectedDate, expectedTime } = await page.evaluate((value) => {
    const date = new Date(value);
    return {
      expectedDate: date.toLocaleDateString([], { month: "short", day: "numeric" }),
      expectedTime: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };
  }, olderTimestamp);

  const inbox = page.getByRole("complementary", { name: "Conversation inbox" });
  const conversationRow = inbox.getByRole("button").filter({ hasText: "Alex Customer" }).first();
  await expect(conversationRow).toContainText(expectedDate);

  await openInboxConversation(page);

  const messageText = page.getByText("Older timestamp test", { exact: true }).last();
  await expect(messageText).toBeVisible();
  const messageBubble = messageText.locator("..");
  await expect(messageBubble).toContainText(expectedTime);
  await expect(messageBubble).not.toContainText(expectedDate);

  expectNoUnexpectedApi(apiState);
});

test("manual Inbox reply sends the exact text without taking ownership", async ({ page }) => {
  const apiState = await installApi(page);

  await page.goto("/inbox");
  await openInboxConversation(page);
  const composer = page.getByPlaceholder("Reply…");
  await expect(composer).toBeVisible();

  await composer.fill("Test reply from staff");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByText("Test reply from staff", { exact: true }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "Take over conversation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Return control to AI" })).toHaveCount(0);

  expect(findCall(apiState, "POST", "/api/conversations/101/messages")?.body).toEqual({
    text: "Test reply from staff",
  });
  expectNoUnexpectedApi(apiState);
});

test("verified CTWA free window shows a compact green banner but still requires opt-in", async ({ page }) => {
  const oldInbound = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  const apiState = await installApi(page, {
    verifiedFreeTemplateWindow: true,
    initialConversations: [conversation({
      latest_inbound_at: oldInbound,
      latest_customer_message_at: oldInbound,
      last_message_at: oldInbound,
      whatsapp_opt_in_at: null,
      whatsapp_opt_in_source: null,
    })],
  });

  await page.goto("/inbox");
  await openInboxConversation(page);

  const banner = page.getByText("Free-entry period verified", { exact: true });
  await expect(banner).toBeVisible();
  await expect(banner.locator("..").locator("..").locator("..")).toHaveClass(/bg-emerald-50/);
  await expect(page.getByText("24h closed. Confirm opt-in before a template.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm opt-in & choose template" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();

  await page.getByRole("button", { name: "Confirm opt-in & choose template" }).click();
  const dialog = page.getByRole("dialog", { name: "Send WhatsApp template" });
  await expect(dialog.getByText("WhatsApp opt-in required")).toBeVisible();
  await expect(dialog.getByText(/A recent free-entry billing receipt was found/)).toBeVisible();
  expectNoUnexpectedApi(apiState);
});

test("verified free-entry banner allows the template picker with recorded opt-in", async ({ page }) => {
  const oldInbound = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  const apiState = await installApi(page, {
    verifiedFreeTemplateWindow: true,
    initialConversations: [conversation({
      latest_inbound_at: oldInbound,
      latest_customer_message_at: oldInbound,
      last_message_at: oldInbound,
      whatsapp_opt_in_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
      whatsapp_opt_in_source: "Customer consented in WhatsApp",
    })],
  });
  await page.goto("/inbox");
  await openInboxConversation(page);
  await expect(page.getByText("Free-entry period verified")).toBeVisible();
  await expect(page.getByText("24h closed. Templates may be free; check consent.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Review consent & templates" })).toBeVisible();
  expectNoUnexpectedApi(apiState);
});

test("verified CTWA remains green for Utility while marketing is opted out", async ({ page }) => {
  const oldInbound = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  const apiState = await installApi(page, {
    verifiedFreeTemplateWindow: true,
    initialConversations: [conversation({
      latest_inbound_at: oldInbound,
      latest_customer_message_at: oldInbound,
      last_message_at: oldInbound,
      whatsapp_opt_in_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
      whatsapp_opt_in_source: "Customer requested service notifications",
      whatsapp_marketing_opt_out_at: new Date(Date.now() - 27 * 60 * 60 * 1000).toISOString(),
    })],
  });
  await page.goto("/inbox");
  await openInboxConversation(page);
  const heading = page.getByText("Free-entry period verified", { exact: true });
  await expect(heading).toBeVisible();
  await expect(heading.locator("..").locator("..").locator("..")).toHaveClass(/bg-emerald-50/);
  await expect(page.getByText("24h closed. Marketing blocked; check Utility templates.")).toBeVisible();
  expectNoUnexpectedApi(apiState);
});

test("paused strict sending keeps CTWA evidence but never paints sending green", async ({ page }) => {
  const oldInbound = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  const apiState = await installApi(page, {
    verifiedFreeTemplateWindow: true,
    freeTemplateSendReady: false,
    initialConversations: [conversation({
      latest_inbound_at: oldInbound,
      latest_customer_message_at: oldInbound,
      last_message_at: oldInbound,
      whatsapp_opt_in_at: oldInbound,
      whatsapp_opt_in_source: "Customer requested updates",
    })],
  });
  await page.goto("/inbox");
  await openInboxConversation(page);
  const heading = page.getByText("Free-entry verified · sending paused", { exact: true });
  await expect(heading).toBeVisible();
  await expect(heading.locator("..").locator("..").locator("..")).toHaveClass(/bg-amber-50/);
  await expect(page.getByText("24h closed. Check the billing status before sending.")).toBeVisible();
  await page.getByRole("button", { name: "Review consent & templates" }).click();
  const dialog = page.getByRole("dialog", { name: "Send WhatsApp template" });
  await expect(dialog.getByText(/A recent free-entry billing receipt was found/)).toBeVisible();
  await expect(dialog.getByText(/Free period verified, but sending is paused/)).toBeVisible();
  expectNoUnexpectedApi(apiState);
});

test("unverified ad leads never get the green banner", async ({ page }) => {
  const oldInbound = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  const apiState = await installApi(page, {
    verifiedFreeTemplateWindow: false,
    initialConversations: [conversation({
      latest_inbound_at: oldInbound,
      latest_customer_message_at: oldInbound,
      last_message_at: oldInbound,
      source: "ctwa",
    })],
  });
  await page.goto("/inbox");
  await openInboxConversation(page);
  await expect(page.getByText("Reply window closed", { exact: true })).toBeVisible();
  await expect(page.getByText("Free-entry period verified")).toHaveCount(0);
  expectNoUnexpectedApi(apiState);
});

test("a verified free entry never paints an opted-out conversation green", async ({ page }) => {
  const oldInbound = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  const apiState = await installApi(page, {
    verifiedFreeTemplateWindow: true,
    initialConversations: [conversation({
      latest_inbound_at: oldInbound,
      latest_customer_message_at: oldInbound,
      last_message_at: oldInbound,
      whatsapp_opt_out_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      whatsapp_opt_in_at: null,
      whatsapp_opt_in_source: null,
    })],
  });
  await page.goto("/inbox");
  await openInboxConversation(page);
  await expect(page.getByText("Customer opted out of WhatsApp messages", { exact: true })).toBeVisible();
  await expect(page.getByText("Free-entry period verified")).toHaveCount(0);
  expectNoUnexpectedApi(apiState);
});

test("closed WhatsApp conversation records opt-in and sends an approved template", async ({ page }) => {
  const oldInbound = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  const apiState = await installApi(page, {
    initialConversations: [
      conversation({
        latest_inbound_at: oldInbound,
        latest_customer_message_at: oldInbound,
        last_message_at: oldInbound,
        whatsapp_opt_in_at: null,
        whatsapp_opt_in_source: null,
      }),
    ],
  });

  await page.goto("/inbox");
  await openInboxConversation(page);

  await expect(page.getByText("Reply window closed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Record opt-in & choose template" }).click();

  const dialog = page.getByRole("dialog", { name: "Send WhatsApp template" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("WhatsApp opt-in required")).toBeVisible();

  await dialog.getByPlaceholder(/Customer requested WhatsApp follow-up/).fill(
    "Customer requested WhatsApp follow-up by phone"
  );
  await dialog.getByLabel(
    "I confirm this customer explicitly agreed to receive WhatsApp messages."
  ).check();
  await dialog.getByRole("button", { name: "Record opt-in" }).click();

  await expect(
    dialog.getByRole("heading", { name: "lead_follow_up", exact: true })
  ).toBeVisible();
  await dialog.getByLabel("Body {{1}}").fill("Alex");
  await dialog.getByLabel(
    "I confirm this customer's consent covers WhatsApp marketing."
  ).check();
  await expect(dialog.getByText("Meta billing — this template may cost money")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Send template" })).toBeDisabled();
  await dialog.getByLabel("I understand Meta may charge for this manual template send.").check();
  await dialog.getByRole("button", { name: "Send template" }).click();

  await expect(page.getByText(/Hi Alex, just following up on your enquiry/)).toBeVisible();
  await expect(page.getByText("Template · lead_follow_up")).toBeVisible();

  expect(findCall(apiState, "POST", "/api/conversations/101/whatsapp-opt-in")?.body).toEqual({
    source: "Customer requested WhatsApp follow-up by phone",
    confirmed: true,
  });
  expect(findCall(apiState, "POST", "/api/conversations/101/whatsapp-templates/send")?.body).toEqual({
    templateName: "lead_follow_up",
    languageCode: "en_US",
    values: { header: [], body: ["Alex"] },
    marketingConsentConfirmed: true,
    billingAcknowledged: true,
    billingReviewToken: "test-review-token",
  });
  expectNoUnexpectedApi(apiState);
});

test("failed WhatsApp template opens original review and refreshes every billing token after 409", async ({ page }) => {
  const oldInbound = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  const apiState = await installApi(page, {
    initialConversations: [conversation({
      latest_inbound_at: oldInbound,
      latest_customer_message_at: oldInbound,
      last_message_at: oldInbound,
      whatsapp_opt_in_at: oldInbound,
      whatsapp_opt_in_source: "Customer explicitly agreed",
    })],
    initialMessages: [...inboundMessages(), {
      id: 27, contact_id: 101, role: "assistant",
      content: "Previous follow-up attempt",
      created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      sent_by_username: "sales-test",
      delivery_status: "failed",
      delivery_error: "Test provider failure",
      whatsapp_template: {
        name: "lead_follow_up", language: "en_US",
        category: "MARKETING",
      },
    }],
  });

  let catalogFetches = 0;
  let attemptedSends = 0;
  const stubTemplates = [
    {
      id: "tpl-alt", name: "alternate_offer", language: "en_US",
      status: "APPROVED", category: "MARKETING", header: null,
      body: { text: "Different offer for {{1}}" }, footer: null,
      buttons: [], variableFields: [
        { component: "body", index: 1, label: "Body {{1}}", example: "Alex" },
      ], sendable: true, unsupportedReason: null,
    },
    {
      id: "tpl-original", name: "lead_follow_up", language: "en_US",
      status: "APPROVED", category: "MARKETING", header: null,
      body: { text: "Original follow-up for {{1}}" }, footer: null,
      buttons: [], variableFields: [
        { component: "body", index: 1, label: "Body {{1}}", example: "Alex" },
      ], sendable: true, unsupportedReason: null,
    },
  ];

  await page.route("**/api/conversations/101/whatsapp-templates", async (route) => {
    catalogFetches += 1;
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        billingAdvisory: {
          evidence: "recent_billable_message",
          reviewedAt: new Date().toISOString(),
          reviewTokens: {
            "lead_follow_up::en_US": "original-token-" + catalogFetches,
            "alternate_offer::en_US": "alternate-token-" + catalogFetches,
          },
        },
        templates: stubTemplates,
        reusableMedia: [],
        eligibility: { allowed: true, code: null, message: null },
      }),
    });
  });
  await page.route("**/api/conversations/101/whatsapp-templates/send", async (route) => {
    attemptedSends += 1;
    await route.fulfill({
      status: 409, contentType: "application/json",
      body: JSON.stringify({
        code: "billing_review_already_used",
        error: "Review already used: check delivery before trying another send.",
        billingAdvisory: {
          evidence: "recent_billable_message",
          reviewTokens: { "lead_follow_up::en_US": "partial-only-token" },
        },
      }),
    });
  });

  await page.goto("/inbox");
  await openInboxConversation(page);
  await page.getByRole("button", { name: "Review & send new template" }).click();

  const dialog = page.getByRole("dialog", { name: "Send WhatsApp template" });
  await expect(dialog.getByRole("heading", { name: "lead_follow_up", exact: true })).toBeVisible();
  await expect(dialog.getByText(/This is a NEW send, not a retry/)).toBeVisible();
  await expect(dialog.getByLabel("Body {{1}}")).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Send template" })).toBeDisabled();

  await dialog.getByLabel("Body {{1}}").fill("Alex");
  await dialog.getByLabel("I confirm this customer's consent covers WhatsApp marketing.").check();
  await dialog.getByLabel("I understand Meta may charge for this manual template send.").check();
  await dialog.getByRole("button", { name: "Send template" }).click();

  await expect(dialog.getByText(/Review already used/)).toBeVisible();
  await expect(dialog.getByLabel("Body {{1}}")).toHaveValue("Alex");
  await expect(dialog.getByLabel("I understand Meta may charge for this manual template send.")).not.toBeChecked();
  await expect.poll(() => catalogFetches).toBeGreaterThanOrEqual(2);

  await dialog.getByRole("button", { name: /alternate_offer/ }).click();
  await expect(dialog.getByRole("heading", { name: "alternate_offer", exact: true })).toBeVisible();
  await dialog.getByLabel("Body {{1}}").fill("Alex");
  await dialog.getByLabel("I confirm this customer's consent covers WhatsApp marketing.").check();
  await dialog.getByLabel("I understand Meta may charge for this manual template send.").check();
  await expect(dialog.getByRole("button", { name: "Send template" })).toBeEnabled();
  expect(attemptedSends).toBe(1);
  expectNoUnexpectedApi(apiState);
});

test("Messenger conversation stays manually replyable in the Human Agent window", async ({ page }) => {
  const oldInbound = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  const apiState = await installApi(page, {
    initialConversations: [
      conversation({
        channel: "facebook",
        human_agent_enabled: true,
        latest_inbound_at: oldInbound,
        latest_customer_message_at: oldInbound,
        last_message_at: oldInbound,
      }),
    ],
  });

  await page.goto("/inbox");
  await openInboxConversation(page);

  await expect(page.getByText(/Staff reply only/)).toBeVisible();
  const composer = page.getByPlaceholder("Reply…");
  await expect(composer).toBeEnabled();

  await composer.fill("Manual Human Agent reply");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByText("Manual Human Agent reply", { exact: true }).last()).toBeVisible();
  expect(findCall(apiState, "POST", "/api/conversations/101/messages")?.body).toEqual({
    text: "Manual Human Agent reply",
  });
  expectNoUnexpectedApi(apiState);
});

test("Messenger stays closed after 24 hours when Human Agent is not enabled", async ({ page }) => {
  const oldInbound = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  const apiState = await installApi(page, {
    initialConversations: [
      conversation({
        channel: "facebook",
        human_agent_enabled: false,
        latest_inbound_at: oldInbound,
        latest_customer_message_at: oldInbound,
        last_message_at: oldInbound,
      }),
    ],
  });

  await page.goto("/inbox");
  await openInboxConversation(page);

  await expect(page.getByText("Reply window closed", { exact: true })).toBeVisible();
  await expect(page.getByText(/Staff reply only/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Record a voice message" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Attach photo, video, or file" })).toBeDisabled();
  expect(findCall(apiState, "POST", "/api/conversations/101/messages")).toBeFalsy();
  expectNoUnexpectedApi(apiState);
});

test("Inbox takeover and Return to AI change ownership through the correct endpoints", async ({ page }) => {
  const apiState = await installApi(page);

  await page.goto("/inbox");
  await openInboxConversation(page);
  await page.getByRole("button", { name: "Take over conversation" }).click();

  await expect(page.getByRole("button", { name: "Return control to AI" })).toBeVisible();
  expect(findCall(apiState, "POST", "/api/conversations/101/takeover")).toBeTruthy();

  await page.getByRole("button", { name: "Return control to AI" }).click();

  await expect(page.getByRole("button", { name: "Take over conversation" })).toBeVisible();
  expect(findCall(apiState, "POST", "/api/conversations/101/return-to-ai")).toBeTruthy();
  expectNoUnexpectedApi(apiState);
});

test("desktop Pipeline drag moves a lead through the existing stage update API", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Desktop HTML5 drag path");

  const apiState = await installApi(page);
  await page.goto("/pipeline");

  const leadCard = page.getByRole("button").filter({ hasText: "Alex Tan" }).first();
  const contactedStage = page.locator('section[data-pipeline-stage-id="2"]');

  await expect(leadCard).toBeVisible();
  await expect(contactedStage).toBeVisible();
  await leadCard.dragTo(contactedStage);

  await expect.poll(() => findCall(apiState, "PATCH", "/api/pipeline/leads/501")?.body)
    .toEqual({ stageId: 2 });
  await expect(contactedStage.getByText("Alex Tan", { exact: true })).toBeVisible();
  expectNoUnexpectedApi(apiState);
});

test("iPad touch drag moves a lead through the same stage update API", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "ipad-landscape", "iPad/WebKit touch path");

  // Playwright's WebKit device emulation supports touch input but does not
  // consistently expose maxTouchPoints. Real iPads do, and the UI deliberately
  // uses that hardware signal to show the touch-only drag grip.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "maxTouchPoints", {
      configurable: true,
      get: () => 5,
    });
  });

  const apiState = await installApi(page);
  await page.goto("/pipeline");
  expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);

  const handle = page.locator('main.ui-kanban-scroll [aria-label="Drag lead to another stage"]');
  const contactedStage = page.locator('section[data-pipeline-stage-id="2"]');

  await expect(handle).toBeVisible();
  await expect(contactedStage).toBeVisible();

  const startBox = await handle.boundingBox();
  const targetBox = await contactedStage.boundingBox();
  expect(startBox).not.toBeNull();
  expect(targetBox).not.toBeNull();

  const startX = startBox.x + startBox.width / 2;
  const startY = startBox.y + startBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + Math.min(120, targetBox.height / 2);

  await page.evaluate(({ startX, startY, endX, endY }) => {
    const handle = document.querySelector('main.ui-kanban-scroll [aria-label="Drag lead to another stage"]');
    if (!handle) throw new Error("Touch drag handle not found");

    const makeTouch = (x, y) => ({
      identifier: 7,
      clientX: x,
      clientY: y,
      pageX: x + window.scrollX,
      pageY: y + window.scrollY,
      screenX: x,
      screenY: y,
    });

    const dispatchTouch = (target, type, touches, changedTouches) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: touches },
        targetTouches: { value: touches },
        changedTouches: { value: changedTouches },
      });
      target.dispatchEvent(event);
    };

    const startTouch = makeTouch(startX, startY);
    dispatchTouch(handle, "touchstart", [startTouch], [startTouch]);

    const moveTouch = makeTouch(endX, endY);
    dispatchTouch(document, "touchmove", [moveTouch], [moveTouch]);

    const endTouch = makeTouch(endX, endY);
    dispatchTouch(document, "touchend", [], [endTouch]);
  }, { startX, startY, endX, endY });

  await expect.poll(() => findCall(apiState, "PATCH", "/api/pipeline/leads/501")?.body)
    .toEqual({ stageId: 2 });
  await expect(contactedStage.getByText("Alex Tan", { exact: true })).toBeVisible();
  expectNoUnexpectedApi(apiState);
});


test("Neutro pelvic voucher Pipeline UX verifies attendance, records terms and redemption, refreshes activity", async ({page}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium","Voucher E2E on desktop Chrome");
  const fixture=pipelineFixture();
  fixture.leads[0].appointment_status="visited";
  fixture.leads[0].treatment_interest="骨盆调理";
  fixture.services=["骨盆调理"];
  const apiState=await installApi(page,{
    authUser:{...STAFF_USER,features:{assessmentVoucherTrackingEnabled:true}},
    initialPipeline:fixture,
    initialVoucher:{status:"not_verified",valueRm:100},
  });
  await page.goto("/pipeline");
  await page.getByRole("button").filter({hasText:"Alex Tan"}).first().click();
  const panel=page.locator('section[aria-label="Pelvic assessment voucher"]');
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Not verified")).toBeVisible();
  await panel.getByRole("button",{name:"Confirm assessment attendance"}).click();
  await expect(panel.getByText("Assessment attended")).toBeVisible();
  await expect(panel.getByRole("button",{name:"Mark voucher issued"})).toBeDisabled();
  await panel.getByRole("checkbox").check();
  await panel.getByPlaceholder(/One-time RM100 off/).fill("RM100 off pelvic care, no stacking with packages");
  await panel.getByRole("button",{name:"Mark voucher issued"}).click();
  await expect(panel.getByText("Voucher issued")).toBeVisible();
  await expect(panel.getByText(/Approved terms:/)).toBeVisible();
  await panel.getByPlaceholder(/Treatment booked/).fill("Staff verified single redemption");
  await panel.getByRole("button",{name:"Mark redeemed"}).click();
  await expect(panel.getByText("Redeemed",{exact:true})).toBeVisible();
  const calls=apiState.calls.filter(x=>x.path==="/api/pipeline/leads/501/assessment-voucher");
  expect(calls.map(x=>x.body?.status)).toEqual(["eligible","issued","redeemed"]);
  expect(calls[1].body).toMatchObject({termsConfirmed:true,termsNote:"RM100 off pelvic care, no stacking with packages"});
  expect(calls[2].body).toMatchObject({redemptionNote:"Staff verified single redemption"});
  await expect(page.getByText("Voucher status updated to redeemed")).toBeVisible();
  expectNoUnexpectedApi(apiState);
});

test("Neutro voucher Pipeline UX prevents issue/redeem on conflicting lead state and hides staff actions for read-only access",async({page},testInfo)=>{
  test.skip(testInfo.project.name!=="desktop-chromium","Voucher E2E on desktop Chrome");
  const fixture=pipelineFixture();
  fixture.leads[0].appointment_status="set";
  fixture.leads[0].treatment_interest="3D 小颜术";
  const apiState=await installApi(page,{
    authUser:{...STAFF_USER,features:{assessmentVoucherTrackingEnabled:true},
      permissions:{...STAFF_USER.permissions,manage_assigned_leads:false}},
    initialPipeline:fixture,
    initialVoucher:{status:"issued",valueRm:100,termsNote:"No stacking",expiresAt:null},
  });
  await page.goto("/pipeline");
  await page.getByRole("button").filter({hasText:"Alex Tan"}).first().click();
  const panel=page.locator('section[aria-label="Pelvic assessment voucher"]');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("alert")).toContainText("no longer has both pelvic");
  await expect(panel.getByRole("button",{name:"Mark redeemed"})).toHaveCount(0);
  await expect(panel.getByRole("button",{name:"Void this voucher"})).toHaveCount(0);
  expect(apiState.calls.filter(x=>x.path==="/api/pipeline/leads/501/assessment-voucher"&&x.method==="POST")).toHaveLength(0);
  expectNoUnexpectedApi(apiState);
});

test("Neutro voucher Pipeline handles a stale update without claiming successful redemption",async({page},testInfo)=>{
  test.skip(testInfo.project.name!=="desktop-chromium","Voucher E2E on desktop Chrome");
  const fixture=pipelineFixture();
  fixture.leads[0].appointment_status="visited";
  fixture.leads[0].treatment_interest="骨盆调理";
  const apiState=await installApi(page,{
    authUser:{...STAFF_USER,features:{assessmentVoucherTrackingEnabled:true}},
    initialPipeline:fixture,voucherWriteError:true,
    initialVoucher:{status:"issued",valueRm:100,termsNote:"One-time",expiresAt:null},
  });
  await page.goto("/pipeline");
  await page.getByRole("button").filter({hasText:"Alex Tan"}).first().click();
  const panel=page.locator('section[aria-label="Pelvic assessment voucher"]');
  await panel.getByPlaceholder(/Treatment booked/).fill("Staff-confirmed redemption");
  await panel.getByRole("button",{name:"Mark redeemed"}).click();
  await expect(panel.getByText("Voucher issued")).toBeVisible();
  await expect(page.getByText(/Voucher state changed, reload this lead/)).toBeVisible();
  expect(apiState.getVoucher().status).toBe("issued");
  expectNoUnexpectedApi(apiState);
});

test("secondary AI media is not labeled Template; real approved templates retain the badge", async ({ page }) => {
  const imageSrc = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
  const imageMessage = (id, caption) => ({
    id,
    contact_id: 101,
    role: "assistant",
    content: caption,
    created_at: recentIso(),
    media_url: imageSrc,
    media_mime_type: "image/png",
    delivery_status: "delivered",
    whatsapp_message_id: `wamid.secondary.ai.${id}`,
    sent_by_username: null,
    whatsapp_template: {
      automatedSecondaryAiMedia: true,
      senderKey: "neutro_secondary",
      anchorMessageId: 1,
    },
  });
  const apiState = await installApi(page, {
    initialConversations: [conversation({
      whatsapp_is_secondary: true,
      whatsapp_sender_key: "neutro_secondary",
    })],
    initialMessages: [
      ...inboundMessages(),
      imageMessage(31, "Pulse Wave result photo 1"),
      imageMessage(32, "Pulse Wave result photo 2"),
      imageMessage(33, "Pulse Wave first trial RM388 graphic"),
      {
        id: 35,
        contact_id: 101,
        role: "assistant",
        content: "2-hour AI follow-up (not a Meta template)",
        created_at: recentIso(),
        delivery_status: "delivered",
        whatsapp_message_id: "wamid.secondary.followup",
        is_automated_follow_up: true,
        whatsapp_template: {
          automatedSecondaryFollowup: true,
          senderKey: "neutro_secondary",
          slotHours: 2,
          anchorMessageId: 1,
        },
      },
      {
        id: 34,
        contact_id: 101,
        role: "assistant",
        content: "Approved follow-up template",
        created_at: recentIso(),
        delivery_status: "delivered",
        whatsapp_message_id: "wamid.approved.template",
        whatsapp_template: {
          name: "follow_up_approved",
          language: "en_US",
          category: "MARKETING",
        },
      },
    ],
  });
  await page.goto("/inbox");
  await openInboxConversation(page);
  for (const caption of [
    "Pulse Wave result photo 1",
    "Pulse Wave result photo 2",
    "Pulse Wave first trial RM388 graphic",
  ]) {
    await expect(page.getByText(caption)).toBeVisible();
  }
  await expect(page.getByText("2-hour AI follow-up (not a Meta template)")).toBeVisible();
  await expect(page.getByText("Template · follow_up_approved")).toBeVisible();
  await expect(page.getByText(/^Template ·\s*$/)).toHaveCount(0);
  await expect(page.getByText(/^Template ·/)).toHaveCount(1);
  expectNoUnexpectedApi(apiState);
});
