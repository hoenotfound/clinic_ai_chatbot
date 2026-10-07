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

const PROGRESSIVE_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wgARCAAQABADASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAABv/EABUBAQEAAAAAAAAAAAAAAAAAAAEC/9oADAMBAAIQAxAAAAEQnQJqP//EABYQAQEBAAAAAAAAAAAAAAAAAAQAEf/aAAgBAQABBQIw4w4w45Mv/8QAFxEBAAMAAAAAAAAAAAAAAAAABQAhMf/aAAgBAwEBPwENzLn/xAAYEQACAwAAAAAAAAAAAAAAAAABAwACEf/aAAgBAgEBPwFbhUaZ/8QAFxABAQEBAAAAAAAAAAAAAAAAADEBEf/aAAgBAQAGPwKIjuv/xAAXEAADAQAAAAAAAAAAAAAAAAAAATER/9oACAEBAAE/IZiImEphiR//2gAMAwEAAgADAAAAEMf/xAAVEQEBAAAAAAAAAAAAAAAAAAAAEf/aAAgBAwEBPxC4/8QAGBEBAAMBAAAAAAAAAAAAAAAAAQARITH/2gAIAQIBAT8QYPQarwJ//8QAGRABAQADAQAAAAAAAAAAAAAAAQARIfHB/9oACAEBAAE/EODbvG4MfCDKpf/Z",
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
      mediaUploads: [],
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

    function browserJpegFrameEncoding(bytes) {
      const progressiveMarkers = new Set([0xc2, 0xc6, 0xca, 0xce]);
      const sofMarkers = new Set([
        0xc0, 0xc1, 0xc2, 0xc3,
        0xc5, 0xc6, 0xc7,
        0xc9, 0xca, 0xcb,
        0xcd, 0xce, 0xcf,
      ]);

      if (
        !(bytes instanceof Uint8Array) ||
        bytes.length < 4 ||
        bytes[0] !== 0xff ||
        bytes[1] !== 0xd8
      ) {
        return null;
      }

      let offset = 2;
      while (offset < bytes.length - 1) {
        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.length) break;

        const marker = bytes[offset];
        offset += 1;

        if (marker === 0xd9 || marker === 0xda) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 1 >= bytes.length) break;

        const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
        if (segmentLength < 2 || offset + segmentLength > bytes.length) break;

        if (sofMarkers.has(marker)) {
          return progressiveMarkers.has(marker) ? "progressive" : "non-progressive";
        }
        offset += segmentLength;
      }

      return null;
    }

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (
        /\/api\/conversations\/\d+\/media(?:\?|$)/.test(url) &&
        init.body instanceof FormData
      ) {
        const image = init.body.get("image");
        if (image instanceof Blob) {
          const bytes = new Uint8Array(await image.arrayBuffer());
          state.mediaUploads.push({
            name: image instanceof File ? image.name : "",
            type: image.type || "",
            size: image.size,
            encoding: image.type === "image/jpeg"
              ? browserJpegFrameEncoding(bytes)
              : null,
          });
        }
      }
      return nativeFetch(input, init);
    };

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
      latestMediaUpload() {
        return state.mediaUploads.at(-1) || null;
      },
    };
  });
}

async function installApi(page, {
  initialConversations = [conversation()],
  initialMessagesByContact = new Map([[101, [inboundMessage()]]]),
  imageSendFailure = null,
  imageSendDelayMs = 0,
  documentSendDelayMs = 0,
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
  const documentRequests = [];
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
      return fulfill(route, {
        username: STAFF_USER.username,
        user: STAFF_USER,
      });
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
      const bodyBuffer = request.postDataBuffer() || Buffer.alloc(0);
      const raw = bodyBuffer.toString("latin1");
      mediaRequests.push({
        contactId,
        contentType: request.headers()["content-type"] || "",
        raw,
        bodyBuffer,
      });

      if (imageSendDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, imageSendDelayMs));
      }
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

    const documentMatch = path.match(/^\/api\/conversations\/(\d+)\/document$/);
    if (documentMatch && method === "POST") {
      const contactId = Number(documentMatch[1]);
      const bodyBuffer = request.postDataBuffer() || Buffer.alloc(0);
      const raw = bodyBuffer.toString("latin1");
      documentRequests.push({
        contactId,
        contentType: request.headers()["content-type"] || "",
        raw,
        bodyBuffer,
      });

      if (documentSendDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, documentSendDelayMs));
      }

      const captionMatch = raw.match(/name="caption"\r\n\r\n([^\r\n]*)/);
      const filenameMatch = raw.match(/name="document"; filename="([^"]+)"/);
      const caption = captionMatch?.[1] || "";
      const filename = filenameMatch?.[1] || "document.pdf";
      const message = {
        id: nextMessageId++,
        role: "assistant",
        content: caption,
        sent_by_username: STAFF_USER.username,
        created_at: new Date().toISOString(),
        media_url: null,
        media_base64: null,
        media_mime_type: "application/pdf",
        media_filename: filename,
        has_media_attachment: true,
        whatsapp_message_id: "wamid.document.success",
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
    documentRequests,
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

function pdfPayload(name = "consultation-form.pdf") {
  return {
    name,
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% test document\n"),
  };
}

function progressiveJpegPayload(name = "progressive-photo.jpg") {
  return {
    name,
    mimeType: "image/jpeg",
    buffer: PROGRESSIVE_JPEG,
  };
}

function jpegFrameEncoding(buffer) {
  const progressiveMarkers = new Set([0xc2, 0xc6, 0xca, 0xce]);
  const sofMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3,
    0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb,
    0xcd, 0xce, 0xcf,
  ]);

  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset < buffer.length - 1) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;

    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= buffer.length) break;

    const segmentLength = (buffer[offset] << 8) | buffer[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;

    if (sofMarkers.has(marker)) {
      return progressiveMarkers.has(marker) ? "progressive" : "non-progressive";
    }
    offset += segmentLength;
  }

  return null;
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

  const sentIndicator = page.getByLabel("Sent");
  await expect(sentIndicator).toBeVisible();
  await expect(sentIndicator).toHaveAttribute("data-delivery-status", "sent");
  await expect(sentIndicator.locator("svg path")).toHaveCount(1);

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

  const readIndicator = page.getByLabel("Read");
  await expect(readIndicator).toBeVisible();
  await expect(readIndicator).toHaveAttribute("data-delivery-status", "read");
  await expect(readIndicator).toHaveClass(/text-sky-300/);
  await expect(readIndicator.locator("svg path")).toHaveCount(2);
  await expect(page.getByLabel("Sent")).toHaveCount(0);
  expectNoUnexpectedApi(apiState);
});

test("Delivered uses double ticks without the blue read state", async ({ page }) => {
  const delivered = outboundMessage({ status: "delivered" });
  const apiState = await installApi(page, {
    initialMessagesByContact: new Map([[101, [inboundMessage(), delivered]]]),
  });

  await page.goto("/inbox");
  await openInboxConversation(page);

  const indicator = page.getByLabel("Delivered");
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveAttribute("data-delivery-status", "delivered");
  await expect(indicator).not.toHaveClass(/text-sky-300/);
  await expect(indicator.locator("svg path")).toHaveCount(2);
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

  await expect(selectedThread.getByText("Bella realtime message", { exact: true })).toHaveCount(0);
  await expect(selectedThread.getByText("Hi, I would like to know more.", { exact: true })).toBeVisible();

  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.getByRole("button", { name: "Back to conversations" }).click();
  }
  await expect(page.getByText("Bella realtime message", { exact: true }).first()).toBeVisible();
  expect(apiState.getMessageFetchCount(101)).toBe(fetchCountBefore);
  expectNoUnexpectedApi(apiState);
});

test("Inbox composer follows WhatsApp-style attachment keyboard and mic/send behavior", async ({ page }) => {
  const apiState = await installApi(page);

  await page.goto("/inbox");
  await openInboxConversation(page);

  const composer = page.locator("textarea").first();
  const attachButton = page.getByRole("button", { name: "Attach photo, video, or file" });
  const micButton = page.getByRole("button", { name: "Record a voice message" });
  const cameraButton = page.getByRole("button", { name: "Open camera" });

  await expect(attachButton).toBeVisible();
  await expect(micButton).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) < 640) {
    await expect(cameraButton).toBeVisible();
  } else {
    await expect(cameraButton).toBeHidden();
  }
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);

  await composer.focus();
  await expect(composer).toBeFocused();
  await attachButton.click();
  await expect(composer).not.toBeFocused();

  const attachmentDialog = page.getByRole("dialog", { name: "Attachment options" });
  await expect(attachmentDialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Return to keyboard" })).toBeVisible();
  await expect(attachmentDialog.getByRole("button", { name: "Photos" })).toBeVisible();
  await expect(attachmentDialog.getByRole("button", { name: "Camera" })).toBeVisible();
  await expect(attachmentDialog.getByRole("button", { name: "Video" })).toBeVisible();
  await expect(attachmentDialog.getByRole("button", { name: "Document" })).toBeVisible();

  await page.getByRole("button", { name: "Return to keyboard" }).click();
  await expect(attachmentDialog).toBeHidden();
  await expect(composer).toBeFocused();

  await attachButton.click();
  await expect(attachmentDialog).toBeVisible();
  await composer.focus();
  await expect(attachmentDialog).toBeHidden();

  await composer.fill("WhatsApp style send state");
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Record a voice message" })).toHaveCount(0);

  await composer.fill("");
  await expect(page.getByRole("button", { name: "Record a voice message" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);
  expectNoUnexpectedApi(apiState);
});

test("staff can preview an image and send it as multipart with its caption", async ({ page }) => {
  const apiState = await installApi(page);

  await page.goto("/inbox");
  await openInboxConversation(page);

  const input = page.locator('input[type="file"][accept*="image/*"]');
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

test("pasted WebP is normalized to a WhatsApp-compatible image before upload", async ({ page }) => {
  const apiState = await installApi(page);

  await page.goto("/inbox");
  await openInboxConversation(page);

  const composer = page.locator("textarea").first();
  const pastedType = await composer.evaluate(async (element) => {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext("2d");
    context.fillStyle = "#16a34a";
    context.fillRect(0, 0, canvas.width, canvas.height);

    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, "image/webp", 0.8);
    });
    if (!blob) return null;

    const file = new File([blob], "clipboard.webp", {
      type: blob.type,
      lastModified: Date.now(),
    });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: [{
          type: file.type,
          getAsFile: () => file,
        }],
        files: [file],
      },
    });
    element.dispatchEvent(event);
    return file.type;
  });

  expect(pastedType).toBe("image/webp");
  await expect(page.getByAltText("Selected attachment")).toBeVisible();
  await expect(page.getByText(/^pasted-image-\d+\.(?:jpg|png)$/)).toBeVisible();
  await expect(page.getByText("Photo · Caption optional", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Send message" }).click();

  expect(apiState.mediaRequests).toHaveLength(1);
  const uploaded = await page.evaluate(
    () => window.__realtimeMediaTest?.latestMediaUpload?.() || null
  );
  expect(uploaded).not.toBeNull();
  expect(["image/jpeg", "image/png"]).toContain(uploaded.type);
  expect(uploaded.type).not.toBe("image/webp");
  expect(uploaded.name).toMatch(/\.(?:jpg|png)$/i);
  expectNoUnexpectedApi(apiState);
});

test("progressive JPEG is normalized before upload", async ({ page }) => {
  const apiState = await installApi(page);

  await page.goto("/inbox");
  await openInboxConversation(page);

  expect(jpegFrameEncoding(PROGRESSIVE_JPEG)).toBe("progressive");

  const input = page.locator('input[type="file"][accept*="image/*"]');
  await input.setInputFiles(progressiveJpegPayload());

  await expect(page.getByText(/^progressive-photo\.(?:jpg|png)$/)).toBeVisible();
  await expect(page.getByText("Photo · Caption optional", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send message" }).click();

  expect(apiState.mediaRequests).toHaveLength(1);

  const uploaded = await page.evaluate(
    () => window.__realtimeMediaTest?.latestMediaUpload?.() || null
  );
  expect(uploaded).not.toBeNull();
  if (uploaded.type === "image/jpeg") {
    expect(uploaded.encoding).toBe("non-progressive");
    expect(uploaded.name).toMatch(/\.jpg$/i);
  } else {
    expect(uploaded.type).toBe("image/png");
    expect(uploaded.name).toMatch(/\.png$/i);
  }

  expectNoUnexpectedApi(apiState);
});

test("a delayed failed image send never overwrites a newer staff draft", async ({ page }) => {
  const apiState = await installApi(page, {
    imageSendFailure: "Image provider temporarily unavailable.",
    imageSendDelayMs: 600,
  });

  await page.goto("/inbox");
  await openInboxConversation(page);

  const input = page.locator('input[type="file"][accept*="image/*"]');
  await input.setInputFiles(imagePayload("slow-failure.png"));

  const composer = page.getByPlaceholder("Add a caption…");
  await composer.fill("Old image caption");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByAltText("Selected attachment")).toHaveCount(0);
  const nextDraft = page.locator("textarea").first();
  await nextDraft.fill("New draft typed while the image is sending");
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();

  await expect(
    page.getByText("Image provider temporarily unavailable.", { exact: true })
  ).toBeVisible();
  await expect(nextDraft).toHaveValue("New draft typed while the image is sending");
  await expect(page.getByAltText("Selected attachment")).toHaveCount(0);
  expect(apiState.mediaRequests).toHaveLength(1);
  expectNoUnexpectedApi(apiState);
});

test("failed image upload keeps the selected image and caption ready for retry", async ({ page }) => {
  const apiState = await installApi(page, {
    imageSendFailure: "Image provider temporarily unavailable.",
  });

  await page.goto("/inbox");
  await openInboxConversation(page);

  const input = page.locator('input[type="file"][accept*="image/*"]');
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

test("document upload uses a local optimistic card and preserves the filename after send and reload", async ({ page }) => {
  const apiState = await installApi(page, { documentSendDelayMs: 500 });

  await page.goto("/inbox");
  await openInboxConversation(page);

  const input = page.locator('input[type="file"][accept*=".pdf"]');
  await input.setInputFiles(pdfPayload("consultation-form.pdf"));

  await expect(page.getByText("consultation-form.pdf", { exact: true })).toBeVisible();
  const caption = page.getByPlaceholder("Add a caption…");
  await caption.fill("Please review this file");
  await page.getByRole("button", { name: "Send message" }).click();

  const optimisticCard = page.locator('a').filter({ hasText: "consultation-form.pdf" }).last();
  await expect(optimisticCard).toBeVisible();
  await expect(optimisticCard).not.toHaveAttribute("href", /optimistic-/);

  await expect.poll(() => apiState.documentRequests.length).toBe(1);
  await expect(page.getByText("Please review this file", { exact: true }).last()).toBeVisible();

  const storedCard = page.locator('a').filter({ hasText: "consultation-form.pdf" }).last();
  await expect(storedCard).toHaveAttribute(
    "href",
    /\/api\/conversations\/101\/messages\/\d+\/media$/
  );

  await page.reload();
  await expect(
    page.getByRole("region", { name: "Conversation with Alex Customer" })
  ).toBeVisible();
  await expect(page.getByText("consultation-form.pdf", { exact: true }).last()).toBeVisible();
  expectNoUnexpectedApi(apiState);
});

test("document forward picker hides Messenger and Instagram conversations", async ({ page }) => {
  const documentMessage = {
    ...outboundMessage({ id: 22, content: "Please review" }),
    media_mime_type: "application/pdf",
    media_filename: "consultation-form.pdf",
    has_media_attachment: true,
  };
  const instagram = conversation({
    contactId: 202,
    name: "Instagram Customer",
    number: "ig-202",
    channel: "instagram",
  });
  const apiState = await installApi(page, {
    initialConversations: [conversation(), instagram],
    initialMessagesByContact: new Map([[101, [inboundMessage(), documentMessage]]]),
  });

  await page.goto("/inbox");
  await openInboxConversation(page);

  const thread = page.getByRole("region", { name: "Conversation with Alex Customer" });
  const documentCard = thread.getByText("consultation-form.pdf", { exact: true });
  await expect(documentCard).toBeVisible();
  const bubble = documentCard.locator("xpath=ancestor::div[contains(@class,'group')][1]");
  await bubble.getByRole("button", { name: "Message actions" }).click();
  await page.getByRole("menuitem", { name: /Forward/ }).click();

  const dialog = page.getByRole("dialog", { name: "Forward message" });
  await expect(dialog.getByText("Documents can be forwarded to WhatsApp only", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Instagram Customer", { exact: false })).toHaveCount(0);
  await expect(dialog.getByText("Alex Customer", { exact: false })).toBeVisible();

  await dialog.getByRole("button", { name: "Close forward message" }).click();
  expectNoUnexpectedApi(apiState);
});

test("staff can record preview and send voice from the inline WhatsApp-style composer", async ({ page }) => {
  const apiState = await installApi(page);

  await page.goto("/inbox");
  await openInboxConversation(page);

  await page.getByRole("button", { name: "Record a voice message" }).click();
  await expect(page.getByRole("button", { name: "Cancel voice recording" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop voice recording" })).toBeVisible();

  await page.getByRole("button", { name: "Stop voice recording" }).click();

  await expect(page.getByRole("button", { name: "Play voice preview" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Discard voice message" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send voice message" })).toBeVisible();

  await page.getByRole("button", { name: "Send voice message" }).click();

  await expect(page.getByRole("button", { name: "Send voice message" })).toHaveCount(0);
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
  await expect(page.getByRole("button", { name: "Attach photo, video, or file" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Record a voice message" })).toBeDisabled();

  const input = page.locator('input[type="file"][accept*="image/*"]');
  await input.setInputFiles(imagePayload("blocked-photo.png"));

  await expect(page.getByAltText("Selected attachment")).toHaveCount(0);
  expect(apiState.mediaRequests).toEqual([]);
  expect(apiState.voiceRequests).toEqual([]);
  expect(
    await page.evaluate(() => window.__realtimeMediaTest.getUserMediaCalls())
  ).toBe(0);
  expectNoUnexpectedApi(apiState);
});

test("stalled mandatory JPEG preparation clears safely and leaves the composer usable", async ({ page }) => {
  const apiState = await installApi(page);
  await page.goto("/inbox");
  await openInboxConversation(page);
  await page.evaluate(() => { window.createImageBitmap = () => new Promise(() => {}); });
  await page.locator('input[type="file"][accept*="image/*"]').setInputFiles(progressiveJpegPayload("stalled.jpeg"));
  await expect(page.getByText("Preparing…", { exact: true })).toBeVisible();
  await expect(page.getByText(/Image preparation took too long/)).toBeVisible({ timeout: 15000 });
  await expect(page.getByAltText("Selected attachment")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Attach photo, video, or file" })).toBeEnabled();
  expect(apiState.mediaRequests).toHaveLength(0);
  expectNoUnexpectedApi(apiState);
});

test("optional compression can time out and send the valid original PNG", async ({ page }) => {
  const apiState = await installApi(page);
  await page.goto("/inbox");
  await openInboxConversation(page);
  await page.evaluate(() => { window.createImageBitmap = () => new Promise(() => {}); });
  await page.locator('input[type="file"][accept*="image/*"]').setInputFiles({
    name: "large.png", mimeType: "image/png", buffer: Buffer.concat([ONE_PIXEL_PNG, Buffer.alloc(1600000)]),
  });
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled({ timeout: 3000 });
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => apiState.mediaRequests.length).toBe(1);
  expectNoUnexpectedApi(apiState);
});
