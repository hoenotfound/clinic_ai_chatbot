import { expect, test } from "@playwright/test";

const reviewer = {
  username: "reviewer",
  role: "admin",
  permissions: {
    view_all_leads: true,
    view_assigned_leads: true,
    reply_to_assigned_leads: true,
    manage_assigned_leads: true,
  },
};

function makeContact() {
  const now = new Date(Date.now() - 10 * 60_000).toISOString();
  return {
    contact_id: 201,
    name: "Review Customer",
    whatsapp_profile_name: "Review Customer",
    whatsapp_number: "60121234567",
    channel: "whatsapp",
    mode: "ai",
    last_message_at: now,
    latest_inbound_at: now,
    last_message: "Can I do 3D after HIFU?",
    last_message_role: "user",
    is_unread: false,
    has_unreplied: false,
    needs_attention: true,
    attention_reason: "AI review requested: pending",
    pending_review_count: 2,
    pending_review_summaries: "[#10] Can I do 3D after HIFU?\n[#11] Is 9D suitable in pregnancy?",
    pending_review_items: [
      { id: 10, messageId: 10, summary: "Can I do 3D after HIFU?", category: "clinical" },
      { id: 11, messageId: 11, summary: "Is 9D suitable in pregnancy?", category: "clinical" },
    ],
  };
}

test("Inbox remains AI while individual staff questions are resolved independently", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    class StubEventSource {
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    window.EventSource = StubEventSource;
  });
  const contact = makeContact();
  const resolvedIds = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data = {};
    if (path === "/api/auth/branding") {
      data = { clientName: "Test Clinic", clientLogoUrl: "" };
    } else if (path === "/api/auth/me") {
      data = { user: reviewer, username: reviewer.username };
    } else if (path === "/api/conversations") {
      data = [contact];
    } else if (path === "/api/conversations/201/messages") {
      data = { messages: [], hasMore: false };
    } else if (path === "/api/conversations/201/attribution") {
      data = { lead: null, attribution: null };
    } else if (/^\/api\/conversations\/201\/reviews\/\d+\/resolve$/.test(path)) {
      const reviewId = Number(path.split("/")[5]);
      resolvedIds.push(reviewId);
      contact.pending_review_items = contact.pending_review_items.filter((r) => r.id !== reviewId);
      contact.pending_review_count = contact.pending_review_items.length;
      contact.pending_review_summaries = contact.pending_review_items.map((r) => "[#" + r.messageId + "] " + r.summary).join("\n");
      if (!contact.pending_review_count) {
        contact.needs_attention = false;
        contact.attention_reason = null;
      }
      data = { ...contact };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });

  await page.goto("/inbox?contact=201");
  const thread = page.locator('section[aria-label="Conversation with Review Customer"]');
  await expect(thread).toBeVisible();
  await expect(thread.getByRole("button", { name: /Needs attention \(2 questions\)/ })).toBeVisible();
  await expect(thread.getByText("AI + Staff Review")).toHaveCount(0);
  await thread.getByRole("button", { name: /Needs attention \(2 questions\)/ }).click();
  await expect(thread.getByRole("button", { name: "Mark question 10 resolved" })).toBeVisible();
  await expect(thread.getByRole("button", { name: "Mark question 11 resolved" })).toBeVisible();

  await thread.getByRole("button", { name: "Mark question 10 resolved" }).click();
  await expect.poll(() => resolvedIds).toEqual([10]);
  await expect(thread.getByRole("button", { name: "Mark question 10 resolved" })).toHaveCount(0);
  await expect(thread.getByRole("button", { name: "Mark question 11 resolved" })).toBeVisible();

  await thread.getByRole("button", { name: "Mark question 11 resolved" }).click();
  await expect.poll(() => resolvedIds).toEqual([10, 11]);
  await expect(thread.getByText("Needs attention", { exact: false })).toHaveCount(0);
});
