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

async function mockPortalApi(page, { loggedIn = false } = {}) {
  let authenticated = loggedIn;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/auth/branding") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          clientName: "Test Clinic",
          clientLogoUrl: "",
          loginTagline: "Staff portal",
        }),
      });
    }

    if (path === "/api/auth/me") {
      if (!authenticated) {
        return route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "Not logged in." }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ username: STAFF_USER.username, user: STAFF_USER }),
      });
    }

    if (path === "/api/auth/login" && method === "POST") {
      authenticated = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ username: STAFF_USER.username, user: STAFF_USER }),
      });
    }

    if (path === "/api/auth/logout" && method === "POST") {
      authenticated = false;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }

    if (path === "/api/conversations" && method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    }

    if (path === "/api/pipeline" && method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ stages: [], leads: [], owners: [] }),
      });
    }

    if (path === "/api/pipeline/configured-branches") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    }

    if (path === "/api/config") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
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
            facebookEnabled: false,
            instagramEnabled: false,
            publicReplyEnabled: false,
            privateReplyEnabled: false,
            publicReplyStyle: "ai",
            fixedPublicReply: "",
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
        }),
      });
    }

    if (path === "/api/config/comment-automation/status") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ facebook: null, instagram: null }),
      });
    }

    if (path === "/api/config/lead-distribution/status") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    });
  });
}

async function expectNoHorizontalPageOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.viewport + 1);
}

test("login page is usable without horizontal overflow", async ({ page }) => {
  await mockPortalApi(page);
  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "Test Clinic" })).toBeVisible();
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.locator("#password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
});

test("protected routes send logged-out staff back to login", async ({ page }) => {
  await mockPortalApi(page);

  for (const path of ["/inbox", "/pipeline", "/tools"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  }
});

test("staff can reach the main portal routes without page-level overflow", async ({ page }) => {
  await mockPortalApi(page, { loggedIn: true });

  for (const path of ["/inbox", "/pipeline", "/tools"]) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(path.replace("/", "\\/") + "$"));
    await expect(page.getByRole("navigation").first()).toBeVisible();
    await expectNoHorizontalPageOverflow(page);
  }
});
