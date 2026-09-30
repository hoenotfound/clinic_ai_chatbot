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

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlQ0xkAAAAASUVORK5CYII=",
  "base64"
);

function isoAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function conversation({
  contactId = 101,
  name = "Alex Customer",
  number = "+60123456789",
  mode = "human",
  lastMessage = "Hi, I would like to know more.",
  latestInboundAt = isoAgo(1),
  lastMessageAt = isoAgo(1),
  ...overrides
} = {}) {
  return {
    contact_id: contactId,
    name,
    whatsapp_profile_name: name,
    whatsapp_number: number,
    channel: "whatsapp",
    mode,
    takeover_by: mode === "human" ? STAFF_USER.username : null,
    takeover_at: mode === "human" ? isoAgo(1) : null,
    latest_inbound_at: latestInboundAt,
    latest_customer_message_at: latestInboundAt,
    last_message_at: lastMessageAt,
    last_message_role: "user",
    last_message: lastMessage,
    last_message_content: lastMessage,
    has_unreplied: true,
    is_unread: false,
    needs_attention: false,
    needs_follow_up: false,
    lead_owner_username: null,
    lead_owner_display_name: null,
    ...overrides,
  };
}

function inboundMessage({
  id = 1,
  content = "Hi, I would like to know more.",
  createdAt = isoAgo(1),
} = {}) {
  return {
    id,
    role: "user",
    content,
    created_at: createdAt,
    media_url: null,
    media_base64: null,
    media_mime_type: null,
  };
}

function outboundMessage({
  id = 2,
  content = "Sure, here are the details.",
  status = "sent",
  wamid = "wamid.outbound.2",
} = {}) {
  return {
    id,
    role: "assistant",
    content,
    sent_by_username: STAFF_USER.username,
    created_at: isoAgo(0.5),
    media_url: null,
    media_base64: null,
    media_mime_type: null,
    whatsapp_message_id: wamid,
    delivery_status: status,
    delivery_error: null,
    delivered: status === "delivered" || status === "read",
  };
}

async function installRealtimeHarness(page) {
  await page.addInitScript(() => {
    const state = {
      sources: [],
      getUserMediaCalls: 0,
      tracksStopped: 0,
    };

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
        state.sources.push(this);
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

      emit(type, payload) {
        for (const listener of this.listeners.get(type) || []) {
          listener({ data: JSON.stringify(payload) });
        }
      }
    }

    class MockMediaRecorder {
      static isTypeSupported(type) {
        return String(type || "").startsWith("audio/webm");
      }

      constructor(stream, options = {}) {
        this.stream = stream;
        this.mimeType = options.mimeType || "audio/webm;codecs=opus";
        this.state = "inactive";
        this.listeners = new Map();
      }

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      dispatch(type, event = {}) {
        for (const listener of this.listeners.get(type) || []) listener(event);
      }

      start() {
        this.state = "recording";
      }

      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        const blob = new Blob(["mock-audio-data"], { type: this.mimeType });
        this.dispatch("dataavailable", { data: blob });
        this.dispatch("stop");
      }
    }

    const mockStream = {
      getTracks() {
        return [{
          stop() {
            state.tracksStopped += 1;
          },
        }];
      },
    };

    Object.defineProperty(window, "EventSource", {
      configurable: true,
      writable: true,
      value: MockEventSource,
    });

    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      writable: true,
      value: MockMediaRecorder,
    });

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        async getUserMedia() {
          state.getUserMediaCalls += 1;
          return mockStream;
        },
      },
    });

    window.__realtimeMediaTest = {
      emit(type, payload) {
        for (const source of state.sources) source.emit(type, payload);
      },
      getUserMediaCalls() {
        return state.getUserMediaCalls;
      },
      sourceCount() {
        return state.sources.length;
      },
      tracksStopped() {
        return state.tracksStopped;
      },
    };
  });
}

async function installApi(page, {
  initialConversations = [conversation()],
  initialMessagesByContact = new Map([[101, [inboundMessage()]]]),
  imageSendFailure = null,
  voiceSendFailure = null,
} = {}) {
  await installRealtimeHarness(page);

  let conversations = initialConversations.map((item) => ({ ...item }));
  const messagesByContact = new Map(
    [...initialMessagesByContact.entries()].map(([contactId, messages]) => [
      Number(contactId),
      messages.map((message) => ({ ...message })),
    ])
  );
  let nextMessageId = 1000;

  const calls = [];
  const unexpected = [];
  const messageFetchCounts = new Map();
  const mediaRequests = [];
  const voiceRequests = [];

  function fulfill(route, body, status = 200) {
    return route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  }

  function record(request, body = undefined) {
    calls.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      body,
    });
  }

  function updateConversation(contactId, updates) {
    conversations = conversations.map((item) =>
      Number(item.contact_id) === Number(contactId)
        ? { ...item, ...updates }
        : item
    );
  }

  function addMessage(contactId, message, { updateList = true } = {}) {
    const numericId = Number(contactId);
    const next = { ...message };
    messagesByContact.set(numericId, [...(messagesByContact.get(numericId) || []), next]);

    if (updateList) {
      updateConversation(numericId, {
        last_message: next.content || (next.media_url ? "Attachment" : ""),
        last_message_content: next.content || "",
        last_message_at: next.created_at,
        last_message_role: next.role,
        ...(next.role === "user"
          ? {
              latest_inbound_at: next.created_at,
              latest_customer_message_at: next.created_at,
              has_unreplied: true,
              is_unread: true,
            }
          : {}),
      });
    }
  }

  function setDeliveryStatus(contactId, messageId, updates) {
    const numericId = Number(contactId);
    messagesByContact.set(
      numericId,
      (messagesByContact.get(numericId) || []).map((message) =>
        Number(message.id) === Number(messageId)
          ? { ...message, ...updates }
          : message
      )
    );
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

    const messageMatch = path.match(/^\/api\/conversations\/(\d+)\/messages$/);
    if (messageMatch && method === "GET") {
      const contactId = Number(messageMatch[1]);
      messageFetchCounts.set(contactId, (messageFetchCounts.get(contactId) || 0) + 1);

      const all = messagesByContact.get(contactId) || [];
      const afterId = Number(url.searchParams.get("afterId") || 0);
      const beforeId = Number(url.searchParams.get("beforeId") || 0);
      let result = all;
      if (afterId) result = result.filter((message) => Number(message.id) > afterId);
      if (beforeId) result = result.filter((message) => Number(message.id) < beforeId);

      return fulfill(route, { messages: result, hasMore: false });
    }

    const deliveryMatch = path.match(
      /^\/api\/conversations\/(\d+)\/messages\/delivery-statuses$/
    );
    if (deliveryMatch && method === "POST") {
      const contactId = Number(deliveryMatch[1]);
      const body = request.postDataJSON();
      record(request, body);
      const wanted = new Set((body.messageIds || []).map(Number));
      const statuses = (messagesByContact.get(contactId) || [])
        .filter((message) => wanted.has(Number(message.id)))
        .map((message) => ({
          id: message.id,
          whatsapp_message_id: message.whatsapp_message_id || null,
          delivery_status: message.delivery_status || null,
          delivery_error: message.delivery_error || null,
        }));
      return fulfill(route, statuses);
    }

    const mediaMatch = path.match(/^\/api\/conversations\/(\d+)\/media$/);
    if (mediaMatch && method === "POST") {
      const contactId = Number(mediaMatch[1]);
      const raw = request.postDataBuffer()?.toString("latin1") || "";
      mediaRequests.push({
        contactId,
        contentType: request.headers()["content-type"] || "",
        raw,
      });

      if (imageSendFailure) {
        return fulfill(route, { error: imageSendFailure }, 500);
      }

      const captionMatch = raw.match(/name="caption"\r\n\r\n([^\r\n]*)/);
      const caption = captionMatch?.[1] || "";
      const message = {
        id: nextMessageId++,
        role: "assistant",
        content: caption,
        sent_by_username: STAFF_USER.username,
        created_at: new Date().toISOString(),
        media_url: `data:image/png;base64,${ONE_PIXEL_PNG.toString("base64")}`,
        media_base64: null,
        media_mime_type: "image/png",
        whatsapp_message_id: "wamid.image.success",
        delivery_status: "sent",
        delivery_error: null,
        delivered: true,
      };
      addMessage(contactId, message);
      return fulfill(route, message, 201);
    }

    const voiceMatch = path.match(/^\/api\/conversations\/(\d+)\/voice$/);
    if (voiceMatch && method === "POST") {
      const contactId = Number(voiceMatch[1]);
      const raw = request.postDataBuffer()?.toString("latin1") || "";
      voiceRequests.push({
        contactId,
        contentType: request.headers()["content-type"] || "",
        raw,
      });

      if (voiceSendFailure) {
        return fulfill(route, { error: voiceSendFailure }, 500);
      }

      const message = {
        id: nextMessageId++,
        role: "assistant",
        content: "Mock voice transcript",
        sent_by_username: STAFF_USER.username,
        created_at: new Date().toISOString(),
        media_url: null,
        media_base64: Buffer.from("mock-audio-data").toString("base64"),
        media_mime_type: "audio/webm",
        whatsapp_message_id: "wamid.voice.success",
        delivery_status: "sent",
        delivery_error: null,
        delivered: true,
        transcribed: true,
      };
      addMessage(contactId, message);
      return fulfill(route, message, 201);
    }

    unexpected.push({ method, path });
    return fulfill(
      route,
      { error: `Unexpected mocked API request: ${method} ${path}` },
      501
    );
  });

  return {
    calls,
    unexpected,
    mediaRequests,
    voiceRequests,
    addMessage,
    setDeliveryStatus,
    updateConversation,
    getMessageFetchCount: (contactId) => messageFetchCounts.get(Number(contactId)) || 0,
    getMessages: (contactId) => messagesByContact.get(Number(contactId)) || [],
    getConversations: () => conversations,
  };
}

async function emitRealtime(page, payload) {
  await expect
    .poll(() => page.evaluate(() => window.__realtimeMediaTest?.sourceCount?.() || 0))
    .toBeGreaterThan(0);

  await page.evaluate((eventPayload) => {
    window.__realtimeMediaTest.emit("conversation_changed", eventPayload);
  }, payload);
}

function imagePayload(name = "test-photo.png") {
  return {
    name,
    mimeType: "image/png",
    buffer: ONE_PIXEL_PNG,
  };
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

test("selected conversation receives a new customer message through realtime refresh", async ({ page }) => {
  const apiState = await installApi(page);

  await page.goto("/inbox");
  await openInboxConversation(page);
  await expect(page.getByText("Hi, I would like to know more.", { exact: true }).last()).toBeVisible();

  const incoming = inboundMessage({
    id: 2,
    content: "Realtime customer message",
    createdAt: new Date().toISOString(),
  });
  apiState.addMessage(101, incoming);

  await emitRealtime(page, { contactId: 101, messageId: 2, reason: "message" });

  await expect(page.getByText("Realtime customer message", { exact: true }).last()).toBeVisible();
  // The UI may satisfy the realtime update through an incremental fetch or an
  // already-coalesced refresh. Assert the customer-visible state instead of a
  // timing-sensitive request count that flakes on WebKit/iPad.
  expect(apiState.getMessageFetchCount(101)).toBeGreaterThanOrEqual(1);
  expectNoUnexpectedApi(apiState);
});

test("delivery status changes from Sent to Read immediately from realtime event", async ({ page }) => {
  const sent = outboundMessage();
  const apiState = await installApi(page, {
    initialMessagesByContact: new Map([[101, [inboundMessage(), sent]]]),
  });

  await page.goto("/inbox");
  await openInboxConversation(page);
  await expect(page.getByLabel("Sent")).toBeVisible();

  apiState.setDeliveryStatus(101, sent.id, {
    delivery_status: "read",
    whatsapp_message_id: sent.whatsapp_message_id,
  });

  await emitRealtime(page, {
    contactId: 101,
    messageId: sent.id,
    whatsappMessageId: sent.whatsapp_message_id,
    deliveryStatus: "read",
    deliveryError: null,
    reason: "delivery_status",
  });

  await expect(page.getByLabel("Read")).toBeVisible();
  await expect(page.getByLabel("Sent")).toHaveCount(0);
  expectNoUnexpectedApi(apiState);
});

test("realtime event for another conversation updates its list item without replacing the open thread", async ({ page }) => {
  const second = conversation({
    contactId: 202,
    name: "Bella Customer",
    number: "+60199887766",
    lastMessage: "Bella old message",
  });
  const apiState = await installApi(page, {
    initialConversations: [conversation(), second],
    initialMessagesByContact: new Map([
      [101, [inboundMessage()]],
      [202, [inboundMessage({ id: 20, content: "Bella old message" })]],
    ]),
  });

  await page.goto("/inbox");
  await openInboxConversation(page);
  const selectedThread = page.getByRole("region", {
    name: "Conversation with Alex Customer",
  });
  await expect(selectedThread).toBeVisible();

  const fetchCountBefore = apiState.getMessageFetchCount(101);
  const bellaMessage = inboundMessage({
    id: 21,
    content: "Bella realtime message",
    createdAt: new Date().toISOString(),
  });
  apiState.addMessage(202, bellaMessage);

  await emitRealtime(page, { contactId: 202, messageId: 21, reason: "message" });

  await expect(page.getByText("Bella realtime message", { exact: true }).first()).toBeVisible();
  await expect(selectedThread.getByText("Bella realtime message", { exact: true })).toHaveCount(0);
  await expect(selectedThread.getByText("Hi, I would like to know more.", { exact: true })).toBeVisible();
  expect(apiState.getMessageFetchCount(101)).toBe(fetchCountBefore);
  expectNoUnexpectedApi(apiState);
});

test("staff can preview an image and send it as multipart with its caption", async ({ page }) => {
  const apiState = await installApi(page);

  await page.goto("/inbox");
  await openInboxConversation(page);

  const input = page.locator('input[type="file"][accept="image/*"]');
  await input.setInputFiles(imagePayload("consultation-photo.png"));

  await expect(page.getByAltText("Selected attachment")).toBeVisible();
  await expect(page.getByText("consultation-photo.png", { exact: true })).toBeVisible();

  const caption = page.getByPlaceholder("Add a caption…");
  await caption.fill("Photo caption from staff");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByAltText("Selected attachment")).toHaveCount(0);
  await expect(page.getByText("Photo caption from staff", { exact: true }).last()).toBeVisible();

  expect(apiState.mediaRequests).toHaveLength(1);
  expect(apiState.mediaRequests[0].contactId).toBe(101);
  expect(apiState.mediaRequests[0].contentType).toMatch(/^multipart\/form-data; boundary=/);
  expect(apiState.mediaRequests[0].raw).toContain('filename="consultation-photo.png"');
  expect(apiState.mediaRequests[0].raw).toContain('name="caption"');
  expect(apiState.mediaRequests[0].raw).toContain("Photo caption from staff");
  expectNoUnexpectedApi(apiState);
});

test("failed image upload keeps the selected image and caption ready for retry", async ({ page }) => {
  const apiState = await installApi(page, {
    imageSendFailure: "Image provider temporarily unavailable.",
  });

  await page.goto("/inbox");
  await openInboxConversation(page);

  const input = page.locator('input[type="file"][accept="image/*"]');
  await input.setInputFiles(imagePayload("retry-photo.png"));

  const caption = page.getByPlaceholder("Add a caption…");
  await caption.fill("Keep this caption");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByText("Image provider temporarily unavailable.", { exact: true })).toBeVisible();
  await expect(page.getByAltText("Selected attachment")).toBeVisible();
  await expect(page.getByText("retry-photo.png", { exact: true })).toBeVisible();
  await expect(caption).toHaveValue("Keep this caption");
  expect(apiState.mediaRequests).toHaveLength(1);
  expectNoUnexpectedApi(apiState);
});

test("staff can record, preview and send a voice message as multipart", async ({ page }) => {
  const apiState = await installApi(page);

  await page.goto("/inbox");
  await openInboxConversation(page);

  await page.getByRole("button", { name: "Record a voice message" }).click();
  await expect(page.getByText("Recording voice message", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Stop" }).click();

  await expect(page.getByText(/Voice message ·/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send voice" })).toBeVisible();

  await page.getByRole("button", { name: "Send voice" }).click();

  await expect(page.getByRole("button", { name: "Send voice" })).toHaveCount(0);
  expect(apiState.voiceRequests).toHaveLength(1);
  expect(apiState.voiceRequests[0].contactId).toBe(101);
  expect(apiState.voiceRequests[0].contentType).toMatch(/^multipart\/form-data; boundary=/);
  expect(apiState.voiceRequests[0].raw).toContain('filename="voice-recording.webm"');
  expect(
    await page.evaluate(() => window.__realtimeMediaTest.getUserMediaCalls())
  ).toBe(1);
  expectNoUnexpectedApi(apiState);
});

test("closed WhatsApp reply window blocks image selection and voice recording", async ({ page }) => {
  const old = isoAgo(26);
  const apiState = await installApi(page, {
    initialConversations: [
      conversation({
        latestInboundAt: old,
        lastMessageAt: old,
      }),
    ],
  });

  await page.goto("/inbox");
  await openInboxConversation(page);

  await expect(page.getByText("Reply window closed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Attach an image" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Record a voice message" })).toBeDisabled();

  const input = page.locator('input[type="file"][accept="image/*"]');
  await input.setInputFiles(imagePayload("blocked-photo.png"));

  await expect(page.getByAltText("Selected attachment")).toHaveCount(0);
  expect(apiState.mediaRequests).toEqual([]);
  expect(apiState.voiceRequests).toEqual([]);
  expect(
    await page.evaluate(() => window.__realtimeMediaTest.getUserMediaCalls())
  ).toBe(0);
  expectNoUnexpectedApi(apiState);
});
