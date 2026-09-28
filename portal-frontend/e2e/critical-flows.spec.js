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

function inboundMessages() {
  return [{
    id: 1,
    role: "user",
    content: "Hi, I would like to know more.",
    created_at: recentIso(),
    media_url: null,
    media_base64: null,
    media_mime_type: null,
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
} = {}) {
  await stubRealtime(page);

  let authenticated = loggedIn;
  let conversations = initialConversations.map((item) => ({ ...item }));
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
      setConversationMode(contactId, "human");
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
              mode: "human",
              takeover_by: STAFF_USER.username,
              last_message_role: "assistant",
              last_message_content: body.text,
              last_message_at: message.created_at,
              has_unreplied: false,
            }
          : item
      ));
      return fulfill(route, message);
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

test("manual Inbox reply sends the exact text and takes ownership", async ({ page }) => {
  const apiState = await installApi(page);

  await page.goto("/inbox");
  const composer = page.getByPlaceholder("Message to take over from AI…");
  await expect(composer).toBeVisible();

  await composer.fill("Test reply from staff");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByText("Test reply from staff", { exact: true }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "Return control to AI" })).toBeVisible();

  expect(findCall(apiState, "POST", "/api/conversations/101/messages")?.body).toEqual({
    text: "Test reply from staff",
  });
  expectNoUnexpectedApi(apiState);
});

test("Inbox takeover and Return to AI change ownership through the correct endpoints", async ({ page }) => {
  const apiState = await installApi(page);

  await page.goto("/inbox");
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

  const handle = page.locator('[aria-label="Drag lead to another stage"]').first();
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
    const handle = document.querySelector('[aria-label="Drag lead to another stage"]');
    if (!handle) throw new Error("Touch drag handle not found");

    const makeTouch = (x, y) => new Touch({
      identifier: 7,
      target: handle,
      clientX: x,
      clientY: y,
      pageX: x + window.scrollX,
      pageY: y + window.scrollY,
      screenX: x,
      screenY: y,
      radiusX: 1,
      radiusY: 1,
      rotationAngle: 0,
      force: 0.5,
    });

    const start = makeTouch(startX, startY);
    handle.dispatchEvent(new TouchEvent("touchstart", {
      bubbles: true,
      cancelable: true,
      touches: [start],
      targetTouches: [start],
      changedTouches: [start],
    }));

    const move = makeTouch(endX, endY);
    document.dispatchEvent(new TouchEvent("touchmove", {
      bubbles: true,
      cancelable: true,
      touches: [move],
      targetTouches: [move],
      changedTouches: [move],
    }));

    const end = makeTouch(endX, endY);
    document.dispatchEvent(new TouchEvent("touchend", {
      bubbles: true,
      cancelable: true,
      touches: [],
      targetTouches: [],
      changedTouches: [end],
    }));
  }, { startX, startY, endX, endY });

  await expect.poll(() => findCall(apiState, "PATCH", "/api/pipeline/leads/501")?.body)
    .toEqual({ stageId: 2 });
  await expect(contactedStage.getByText("Alex Tan", { exact: true })).toBeVisible();
  expectNoUnexpectedApi(apiState);
});
