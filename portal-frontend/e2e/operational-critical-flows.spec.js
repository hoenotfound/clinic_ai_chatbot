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

function isoAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function isoFromNow(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function conversation(overrides = {}) {
  return {
    contact_id: 101,
    name: "Alex Customer",
    whatsapp_profile_name: "Alex Customer",
    whatsapp_number: "+60123456789",
    channel: "whatsapp",
    mode: "human",
    takeover_by: STAFF_USER.username,
    takeover_at: isoAgo(1),
    latest_inbound_at: isoAgo(1),
    latest_customer_message_at: isoAgo(1),
    last_message_at: isoAgo(1),
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

function inboundMessage() {
  return {
    id: 1,
    role: "user",
    content: "Hi, I would like to know more.",
    created_at: isoAgo(1),
    media_url: null,
    media_base64: null,
    media_mime_type: null,
  };
}

function defaultConfig() {
  return {
    automatedFollowUp: {
      enabled: false,
      delayMinutes: 10,
      triggerMode: "all",
      message: "Following up",
      translations: {
        en: "Following up",
        ms: "Following up",
        zh: "Following up",
      },
      imageUrl: "",
      activatedAt: null,
    },
    commentAutomation: {
      enabled: false,
      facebookEnabled: true,
      instagramEnabled: true,
      publicReplyEnabled: true,
      privateReplyEnabled: true,
      publicReplyStyle: "ai",
      fixedPublicReply: "Thanks for your comment! I’ll send you a private message 😊",
      skipEmojiOnly: true,
      skipNestedReplies: true,
      activatedAt: null,
    },
    leadScoring: {
      enabled: false,
      inactivityMinutes: 10,
      maxConversationMinutes: 60,
      maxMessages: 40,
      activatedAt: null,
    },
    leadDistribution: {
      enabled: false,
      mode: "round_robin",
    },
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
        this.onopen = null;
        this.onerror = null;
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

async function installOperationalApi(page, {
  initialConversation = conversation(),
  initialMessages = [inboundMessage()],
  initialConfig = defaultConfig(),
  initialScheduled = [],
  scheduledMessagingAllowed = true,
  scheduledPolicyCode = null,
  scheduledPolicyMessage = "",
} = {}) {
  await stubRealtime(page);

  let conversations = [{ ...initialConversation }];
  let messages = initialMessages.map((item) => ({ ...item }));
  let config = structuredClone(initialConfig);
  let scheduled = initialScheduled.map((item) => ({ ...item }));
  let nextScheduledId = 900;

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

  function scheduledResponse() {
    return {
      items: scheduled,
      lastInboundAt: initialConversation.latest_inbound_at || null,
      windowEndsAt: scheduledMessagingAllowed ? isoFromNow(180) : isoAgo(1),
      staffMode: initialConversation.mode === "human",
      channel: initialConversation.channel || "whatsapp",
      messagingAllowed: scheduledMessagingAllowed,
      policyCode: scheduledPolicyCode,
      policyMessage: scheduledPolicyMessage,
    };
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
      return fulfill(route, {
        username: STAFF_USER.username,
        user: STAFF_USER,
      });
    }

    if (path === "/api/conversations" && method === "GET") {
      return fulfill(route, conversations);
    }

    const messagesMatch = path.match(/^\/api\/conversations\/(\d+)\/messages$/);
    if (messagesMatch && method === "GET") {
      const afterId = Number(url.searchParams.get("afterId") || 0);
      const beforeId = Number(url.searchParams.get("beforeId") || 0);
      let result = messages;
      if (afterId) result = result.filter((item) => Number(item.id) > afterId);
      if (beforeId) result = result.filter((item) => Number(item.id) < beforeId);
      return fulfill(route, { messages: result, hasMore: false });
    }

    const deliveryMatch = path.match(/^\/api\/conversations\/(\d+)\/messages\/delivery-statuses$/);
    if (deliveryMatch && method === "POST") {
      return fulfill(route, []);
    }

    const retryMatch = path.match(/^\/api\/conversations\/(\d+)\/messages\/(\d+)\/retry$/);
    if (retryMatch && method === "POST") {
      const messageId = Number(retryMatch[2]);
      record(request);
      let updated = null;
      messages = messages.map((message) => {
        if (Number(message.id) !== messageId) return message;
        updated = {
          ...message,
          accepted: true,
          whatsapp_message_id: "wamid.retry-success",
          delivery_status: "sent",
          delivery_error: null,
        };
        return updated;
      });
      return fulfill(route, updated || { error: "Message not found." }, updated ? 200 : 404);
    }

    const scheduledCollectionMatch = path.match(/^\/api\/conversations\/(\d+)\/scheduled-messages$/);
    if (scheduledCollectionMatch && method === "GET") {
      return fulfill(route, scheduledResponse());
    }

    if (scheduledCollectionMatch && method === "POST") {
      const body = request.postDataJSON();
      record(request, body);
      const item = {
        id: nextScheduledId++,
        contact_id: Number(scheduledCollectionMatch[1]),
        content: body.content,
        scheduled_for: body.scheduledFor,
        scheduled_by_username: STAFF_USER.username,
        status: "scheduled",
        failure_reason: null,
      };
      scheduled = [...scheduled, item];
      return fulfill(route, { item, windowEndsAt: scheduledResponse().windowEndsAt }, 201);
    }

    const scheduledItemMatch = path.match(/^\/api\/conversations\/(\d+)\/scheduled-messages\/(\d+)$/);
    if (scheduledItemMatch && method === "DELETE") {
      const scheduledId = Number(scheduledItemMatch[2]);
      record(request);
      const item = scheduled.find((entry) => Number(entry.id) === scheduledId);
      scheduled = scheduled.filter((entry) => Number(entry.id) !== scheduledId);
      return fulfill(route, { item: item ? { ...item, status: "cancelled" } : null });
    }

    if (path === "/api/config" && method === "GET") {
      return fulfill(route, config);
    }

    if (path === "/api/config" && method === "PATCH") {
      const body = request.postDataJSON();
      record(request, body);
      config = {
        ...config,
        ...body,
        ...(body.commentAutomation
          ? { commentAutomation: { ...config.commentAutomation, ...body.commentAutomation } }
          : {}),
        ...(body.automatedFollowUp
          ? { automatedFollowUp: { ...config.automatedFollowUp, ...body.automatedFollowUp } }
          : {}),
      };
      return fulfill(route, config);
    }

    if (path === "/api/config/comment-automation/status" && method === "GET") {
      return fulfill(route, {
        facebook: {
          state: "ready",
          label: "Ready",
          detail: "Facebook Page connection is ready.",
        },
        instagram: {
          state: "ready",
          label: "Ready",
          detail: "Instagram connection is ready.",
        },
      });
    }

    if (path === "/api/config/lead-distribution/status" && method === "GET") {
      return fulfill(route, {});
    }

    unexpected.push({ method, path });
    return fulfill(route, {
      error: `Unexpected mocked API request: ${method} ${path}`,
    }, 501);
  });

  return {
    calls,
    unexpected,
    getMessages: () => messages,
    getScheduled: () => scheduled,
    getConfig: () => config,
  };
}

function findCall(apiState, method, path) {
  return apiState.calls.find((call) => call.method === method && call.path === path);
}

function expectNoUnexpectedApi(apiState) {
  expect(apiState.unexpected, "All browser API calls should be explicitly mocked").toEqual([]);
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

test("closed 24-hour reply window blocks normal staff sending", async ({ page }) => {
  const old = isoAgo(26);
  const apiState = await installOperationalApi(page, {
    initialConversation: conversation({
      latest_inbound_at: old,
      latest_customer_message_at: old,
      last_message_at: old,
    }),
  });

  await page.goto("/inbox");
  await openInboxConversation(page);

  await expect(page.getByText("Reply window closed", { exact: true })).toBeVisible();
  await expect(
    page.getByText("The customer must message again before a normal WhatsApp reply can be sent.", {
      exact: true,
    })
  ).toBeVisible();

  const composer = page.getByPlaceholder("WhatsApp reply unavailable");
  await composer.fill("This must not be sent.");
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Attach an image" })).toBeDisabled();

  expect(findCall(apiState, "POST", "/api/conversations/101/messages")).toBeUndefined();
  expectNoUnexpectedApi(apiState);
});

test("ordinary delivery failure can be retried and returns to sent state", async ({ page }) => {
  const apiState = await installOperationalApi(page, {
    initialMessages: [
      inboundMessage(),
      {
        id: 2,
        role: "assistant",
        content: "Here are the details.",
        sent_by_username: STAFF_USER.username,
        created_at: isoAgo(0.5),
        whatsapp_message_id: null,
        delivery_status: "failed",
        delivery_error: "Temporary provider failure.",
        media_url: null,
        media_base64: null,
        media_mime_type: null,
      },
    ],
  });

  await page.goto("/inbox");
  await openInboxConversation(page);

  await expect(page.getByText("Not delivered", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(page.getByText("Message queued again.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Sent")).toBeVisible();

  expect(findCall(apiState, "POST", "/api/conversations/101/messages/2/retry")).toBeTruthy();
  expect(apiState.getMessages().find((item) => item.id === 2)?.delivery_status).toBe("sent");
  expectNoUnexpectedApi(apiState);
});

test("policy-blocked delivery failure explains the restriction and hides Retry", async ({ page }) => {
  const apiState = await installOperationalApi(page, {
    initialMessages: [
      inboundMessage(),
      {
        id: 2,
        role: "assistant",
        content: "Follow-up message",
        sent_by_username: STAFF_USER.username,
        created_at: isoAgo(0.5),
        whatsapp_message_id: null,
        delivery_status: "failed",
        delivery_error: "The 24-hour customer-service window has closed.",
        media_url: null,
        media_base64: null,
        media_mime_type: null,
      },
    ],
  });

  await page.goto("/inbox");
  await openInboxConversation(page);

  await expect(page.getByText("Not delivered", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Cannot retry: The customer must message again before a normal WhatsApp reply can be sent.",
      { exact: true }
    )
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);

  expect(findCall(apiState, "POST", "/api/conversations/101/messages/2/retry")).toBeUndefined();
  expectNoUnexpectedApi(apiState);
});

test("staff can schedule and then cancel a message from the Inbox composer", async ({ page }) => {
  const apiState = await installOperationalApi(page);

  await page.goto("/inbox?contact=101");

  const scheduleButton = page.getByRole("button", { name: "Schedule message" }).first();
  await expect(scheduleButton).toBeVisible();
  await scheduleButton.click();

  const dialog = page.getByRole("dialog", { name: "Schedule message" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("Type the message to send later…").fill("Follow up this afternoon");
  await dialog.getByRole("button", { name: "30m" }).click();
  await dialog.getByRole("button", { name: "Schedule message" }).click();

  await expect(dialog).toBeHidden();

  const createCall = findCall(apiState, "POST", "/api/conversations/101/scheduled-messages");
  expect(createCall?.body?.content).toBe("Follow up this afternoon");
  expect(new Date(createCall?.body?.scheduledFor).getTime()).toBeGreaterThan(Date.now());
  expect(apiState.getScheduled()).toHaveLength(1);

  await page.getByRole("button", { name: "Schedule message" }).first().click();
  const reopened = page.getByRole("dialog", { name: "Schedule message" });
  await expect(reopened.getByText("Follow up this afternoon", { exact: true })).toBeVisible();
  await reopened.getByRole("button", { name: "Cancel send" }).click();

  await expect(reopened.getByText("No scheduled messages for this conversation.")).toBeVisible();
  expect(findCall(apiState, "DELETE", "/api/conversations/101/scheduled-messages/900")).toBeTruthy();
  expect(apiState.getScheduled()).toEqual([]);
  expectNoUnexpectedApi(apiState);
});

test("Comment Automation saves the exact customer-flow choice", async ({ page }) => {
  const apiState = await installOperationalApi(page);

  await page.goto("/tools?tool=comment-automation");

  await expect(page.getByRole("heading", { name: "Comment automation" })).toBeVisible();
  await expect(page.getByText("Connections look ready.", { exact: true })).toBeVisible();

  await page.getByRole("switch", { name: "Enable Comment automation" }).click();
  await page.getByText("Send a private message only", { exact: true }).click();
  await expect(page.getByRole("radio", { name: /Send a private message only/ })).toBeChecked();

  await page.getByRole("button", { name: "Save & turn on" }).click();

  await expect(page.getByText("Comment automation is active.", { exact: true })).toBeVisible();
  await expect(page.getByText("You have unsaved changes", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);

  const saveCall = findCall(apiState, "PATCH", "/api/config");
  expect(saveCall?.body).toEqual({
    commentAutomation: {
      enabled: true,
      facebookEnabled: true,
      instagramEnabled: true,
      publicReplyEnabled: false,
      privateReplyEnabled: true,
      publicReplyStyle: "ai",
      fixedPublicReply: "Thanks for your comment! I’ll send you a private message 😊",
      skipEmojiOnly: true,
      skipNestedReplies: true,
    },
  });
  expect(apiState.getConfig().commentAutomation.enabled).toBe(true);
  expect(apiState.getConfig().commentAutomation.publicReplyEnabled).toBe(false);
  expect(apiState.getConfig().commentAutomation.privateReplyEnabled).toBe(true);
  expectNoUnexpectedApi(apiState);
});
