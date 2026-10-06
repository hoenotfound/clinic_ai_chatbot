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
      return fulfill(route, { username: STAFF_USER.username, user: STAFF_USER });
    }

    if (path === "/api/auth/login" && method === "POST") {
      const body = request.postDataJSON();
      record(request, body);
      authenticated = true;
      return fulfill(route, { username: STAFF_USER.username, user: STAFF_USER });
    }

    if (path === "/api/auth/logout" && method === "POST") {
      record(request);
      authenticated = false;
      return fulfill(route, { ok: true });
    }

    if (path === "/api/conversations" && method === "GET") {
      return fulfill(route, conversations);
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

    const templateListMatch = path.match(/^\/api\/conversations\/(\d+)\/whatsapp-templates$/);
    if (templateListMatch && method === "GET") {
      const contactId = Number(templateListMatch[1]);
      const contact = conversations.find((item) => Number(item.contact_id) === contactId);
      const optedIn = Boolean(contact?.whatsapp_opt_in_at && contact?.whatsapp_opt_in_source);
      const optedOut = Boolean(contact?.whatsapp_opt_out_at);
      return fulfill(route, {
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
    expect(viewport).not.toBeNull();
    expect(box).not.toBeNull();
    expect(Math.abs(box.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.width - viewport.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y + box.height - viewport.height)).toBeLessThanOrEqual(2);

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
  await expect(page.getByText("1 contact", { exact: true })).toBeVisible();
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
  });
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
