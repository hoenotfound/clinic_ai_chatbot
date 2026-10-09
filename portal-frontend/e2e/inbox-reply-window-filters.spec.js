import { expect, test } from "@playwright/test";

const HOUR = 60 * 60 * 1000;
const ago = (hours) => new Date(Date.now() - hours * HOUR).toISOString();

const user = {
  username: "inbox-reviewer",
  displayName: "Inbox Reviewer",
  role: "admin",
  permissions: {
    view_all_leads: true,
    view_assigned_leads: true,
    reply_to_assigned_leads: true,
    manage_assigned_leads: true,
  },
};

function conversation(id, name, changes = {}) {
  return {
    contact_id: id,
    name,
    whatsapp_profile_name: name,
    whatsapp_number: `60120000${id}`,
    channel: "whatsapp",
    mode: "ai",
    latest_inbound_at: ago(1),
    last_message_at: ago(1),
    last_message: "Hello",
    last_message_role: "user",
    has_unreplied: false,
    is_unread: false,
    needs_follow_up: false,
    needs_attention: false,
    ...changes,
  };
}

async function mockInbox(page, conversations) {
  await page.addInitScript(() => {
    class TestEventSource {
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    window.EventSource = TestEventSource;
  });

  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let value = {};
    if (pathname === "/api/auth/branding") {
      value = { clientName: "Test Clinic", clientLogoUrl: "", loginTagline: "Staff portal" };
    } else if (pathname === "/api/auth/me") {
      value = { user, username: user.username };
    } else if (pathname === "/api/conversations") {
      value = conversations;
    } else if (/^\/api\/conversations\/\d+\/messages$/.test(pathname)) {
      value = { messages: [], hasMore: false };
    } else if (/^\/api\/conversations\/\d+\/attribution$/.test(pathname)) {
      value = { lead: null, attribution: null };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  });
}

async function openFilters(page) {
  const inbox = page.getByRole("complementary", { name: "Conversation inbox" });
  await expect(inbox.getByText("Inbox", { exact: true })).toBeVisible();
  await inbox.getByRole("button", { name: /Filters/ }).click();
  return { inbox, reply: inbox.getByRole("combobox", { name: "Reply window" }) };
}

test("Inbox filters reply-window status, keeps staff-only distinct and scopes counts", async ({ page }) => {
  await mockInbox(page, [
    conversation(101, "WhatsApp Open"),
    conversation(102, "WhatsApp Expired", { latest_inbound_at: ago(26), is_unread: true }),
    conversation(103, "Messenger Staff", { channel: "facebook", human_agent_enabled: true, latest_inbound_at: ago(72) }),
    conversation(104, "Instagram Expired", { channel: "instagram", latest_inbound_at: ago(72) }),
    conversation(105, "Never Messaged", { latest_inbound_at: null }),
    conversation(106, "Opted Out Open", { whatsapp_opt_out_at: ago(2) }),
  ]);

  await page.goto("/inbox");
  const { inbox, reply } = await openFilters(page);
  const status = inbox.getByRole("combobox", { name: "Status" });
  await expect(reply.locator("option[value='open']")).toHaveText("Open (3)");
  await expect(reply.locator("option[value='expired']")).toHaveText("Expired (3)");
  await expect(status.locator("option[value='all']")).toHaveText("All (6)");
  await expect(status.locator("option[value='unread']")).toHaveText("Unread (1)");
  await expect(inbox.getByText("Staff only", { exact: true })).toBeVisible();

  await reply.selectOption("open");
  await expect(status.locator("option[value='all']")).toHaveText("All (3)");
  await expect(status.locator("option[value='unread']")).toHaveText("Unread (0)");
  await expect(inbox.getByText("WhatsApp Open", { exact: true })).toBeVisible();
  await expect(inbox.getByText("Messenger Staff", { exact: true })).toBeVisible();
  await expect(inbox.getByText("Opted Out Open", { exact: true })).toBeVisible();
  await expect(inbox.getByText("WhatsApp Expired", { exact: true })).toHaveCount(0);

  await inbox.getByRole("combobox", { name: "Channel" }).selectOption("whatsapp");
  await expect(reply.locator("option[value='open']")).toHaveText("Open (2)");
  await expect(reply.locator("option[value='expired']")).toHaveText("Expired (2)");
  await expect(status.locator("option[value='all']")).toHaveText("All (2)");
  await expect(inbox.getByText("Messenger Staff", { exact: true })).toHaveCount(0);

  await reply.selectOption("expired");
  await expect(status.locator("option[value='all']")).toHaveText("All (2)");
  await expect(status.locator("option[value='unread']")).toHaveText("Unread (1)");
  await expect(inbox.getByText("WhatsApp Expired", { exact: true })).toBeVisible();
  await expect(inbox.getByText("Never Messaged", { exact: true })).toBeVisible();
  await expect(inbox.getByText("WhatsApp Open", { exact: true })).toHaveCount(0);

  const search = inbox.getByRole("searchbox", { name: /Search by name/ });
  await search.fill("Never");
  await expect(reply.locator("option[value='open']")).toHaveText("Open (0)");
  await expect(reply.locator("option[value='expired']")).toHaveText("Expired (1)");
  await expect(status.locator("option[value='all']")).toHaveText("All (1)");
  await expect(status.locator("option[value='unread']")).toHaveText("Unread (0)");
  await expect(inbox.getByText("Never Messaged", { exact: true })).toBeVisible();

  await inbox.getByRole("button", { name: "Clear filters" }).click();
  await expect(reply).toHaveValue("all");
  await expect(inbox.getByRole("combobox", { name: "Channel" })).toHaveValue("all");
  await expect(search).toHaveValue("Never");
  await search.fill("");
  await expect(inbox.getByText("WhatsApp Open", { exact: true })).toBeVisible();
});

test("Desktop never displays an out-of-filter conversation thread", async ({ page }) => {
  test.skip((page.viewportSize()?.width || 0) < 1024, "Desktop selected-thread behavior");

  await mockInbox(page, [
    conversation(101, "Currently Open"),
    conversation(102, "Expired Customer", { latest_inbound_at: ago(30) }),
  ]);
  await page.goto("/inbox");
  const { inbox, reply } = await openFilters(page);
  await expect(page.locator('section[aria-label="Conversation with Currently Open"]')).toBeVisible();

  await reply.selectOption("expired");
  await expect(inbox.getByText("Currently Open", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "No conversation selected" })).toBeVisible();
  await expect(page.locator('section[aria-label="Conversation with Currently Open"]')).toHaveCount(0);

  await inbox.getByRole("button").filter({ hasText: "Expired Customer" }).click();
  await expect(page.locator('section[aria-label="Conversation with Expired Customer"]')).toBeVisible();
  await expect(page.getByRole("region", { name: "No conversation selected" })).toHaveCount(0);
});

test("Opening an unread chat keeps its thread visible as it gets marked read", async ({ page }) => {
  await mockInbox(page, [
    conversation(101, "Previously Read"),
    conversation(102, "Unread Lead", { is_unread: true }),
  ]);
  await page.goto("/inbox");
  const { inbox } = await openFilters(page);
  await inbox.getByRole("combobox", { name: "Status" }).selectOption("unread");
  const unreadRow = inbox.getByRole("button").filter({ hasText: "Unread Lead" });
  await expect(unreadRow).toBeVisible();
  await unreadRow.click();

  await expect(page.locator('section[aria-label="Conversation with Unread Lead"]')).toBeVisible();
  await expect(inbox.getByText("Unread Lead", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "No conversation selected" })).toHaveCount(0);
});

test("An open chat moves to Expired when its reply window closes without new messages", async ({ page }) => {
  const startedAt = new Date();
  await page.clock.install({ time: startedAt });
  await mockInbox(page, [
    conversation(101, "Almost Expired", { latest_inbound_at: new Date(startedAt.getTime() - 23.5 * HOUR).toISOString() }),
  ]);
  await page.goto("/inbox");
  const { inbox, reply } = await openFilters(page);
  await reply.selectOption("open");
  await expect(inbox.getByText("Almost Expired", { exact: true })).toBeVisible();

  await page.clock.fastForward(40 * 60 * 1000);
  await expect(reply.locator("option[value='open']")).toHaveText("Open (0)");
  await expect(reply.locator("option[value='expired']")).toHaveText("Expired (1)");
  await expect(inbox.getByText("Almost Expired", { exact: true })).toHaveCount(0);
  await reply.selectOption("expired");
  await expect(inbox.getByText("Almost Expired", { exact: true })).toBeVisible();
});

test("Inbox advanced filters share a balanced, touch-friendly grid with single-row chips", async ({ page }) => {
  await mockInbox(page, [
    conversation(101, "WhatsApp Open"),
    conversation(102, "WhatsApp Expired", { latest_inbound_at: ago(26), is_unread: true }),
  ]);
  await page.goto("/inbox");
  const { inbox, reply } = await openFilters(page);
  const status = inbox.getByRole("combobox", { name: "Status" });
  const channel = inbox.getByRole("combobox", { name: "Channel" });
  const owner = inbox.getByRole("combobox", { name: "Lead owner" });
  const handled = inbox.getByRole("combobox", { name: "Handled by" });

  for (const control of [status, channel, owner, handled, reply]) {
    await expect(control).toBeVisible();
    const rect = await control.boundingBox();
    expect(rect?.height).toBeGreaterThanOrEqual(44);
  }
  const bounds = await Promise.all([status, channel, owner, handled, reply].map((item) => item.boundingBox()));
  const [statusRect, channelRect, ownerRect, handledRect, replyRect] = bounds;
  expect(Math.abs(statusRect.y - channelRect.y)).toBeLessThan(3);
  expect(Math.abs(handledRect.y - replyRect.y)).toBeLessThan(3);
  expect(Math.abs(handledRect.width - replyRect.width)).toBeLessThan(3);
  expect(ownerRect.width).toBeGreaterThan(statusRect.width);

  await channel.selectOption("whatsapp");
  await reply.selectOption("expired");
  await status.selectOption("unread");
  const chips = inbox.getByLabel("Active Inbox filters");
  await expect(chips.getByRole("button")).toHaveCount(3);
  const geometry = await chips.evaluate((node) => {
    const rects = [...node.querySelectorAll("button")].map((child) => child.getBoundingClientRect());
    return { sameRow: rects.every((rect) => Math.abs(rect.top - rects[0].top) < 2), withinViewport: node.getBoundingClientRect().right <= window.innerWidth };
  });
  expect(geometry.sameRow).toBe(true);
  expect(geometry.withinViewport).toBe(true);
});
