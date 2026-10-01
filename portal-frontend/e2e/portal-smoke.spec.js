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


    if (path === "/api/pipeline/analytics" && method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          filterOptions: {
            branches: [],
            channels: [],
            sources: [],
            campaigns: [],
            treatments: [],
            owners: [],
          },
          summary: {
            newLeads: 12,
            appointments: 5,
            visits: 4,
            won: 2,
            estimatedWonValue: 2800,
            conversionRate: 16.7,
          },
          comparison: {
            deltas: {
              newLeads: 9.1,
              appointments: 25,
              visits: 0,
              won: 100,
              conversionRate: 7.6,
            },
          },
          cohort: {
            appointmentRate: 41.7,
            showRate: 80,
            closeRate: 50,
          },
          funnel: [
            { label: "Leads", count: 12, fromPreviousRate: 100, dropOff: 0, fromLeadRate: 100 },
            { label: "Appointments", count: 5, fromPreviousRate: 41.7, dropOff: 7, fromLeadRate: 41.7 },
            { label: "Visits", count: 4, fromPreviousRate: 80, dropOff: 1, fromLeadRate: 33.3 },
            { label: "Won", count: 2, fromPreviousRate: 50, dropOff: 2, fromLeadRate: 16.7 },
          ],
          trend: [
            { day: "2026-09-25", newLeads: 2, appointments: 1, visits: 1, won: 0 },
            { day: "2026-09-26", newLeads: 4, appointments: 2, visits: 1, won: 1 },
            { day: "2026-09-27", newLeads: 1, appointments: 0, visits: 1, won: 0 },
            { day: "2026-09-28", newLeads: 5, appointments: 2, visits: 1, won: 1 },
            { day: "2026-09-29", newLeads: 3, appointments: 1, visits: 0, won: 0 },
            { day: "2026-09-30", newLeads: 6, appointments: 3, visits: 2, won: 1 },
          ],
          temperature: [],
          responseTimes: {
            automated: { samples: 0, medianSeconds: 0, p90Seconds: 0 },
            staff: { samples: 0, medianSeconds: 0, p90Seconds: 0 },
          },
          performance: {
            source: [],
            campaign: [],
            treatment: [],
            branch: [],
            channel: [],
            owner: [],
          },
          followUps: {
            leadsFollowedUp: 0,
            leadsReplied72h: 0,
            replyRate72h: 0,
            outcomeWindowDays: 7,
            leadsWithAppointmentAfter: 0,
            leadsWonAfter: 0,
          },
          lostReasons: [],
          systemHealth: {
            aiScoring: { attempts: 0, failed: 0 },
            delivery: { tracked: 0, failed: 0, failureRate: 0 },
          },
        }),
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

async function expectNoHorizontalElementOverflow(page, testId) {
  const element = page.getByTestId(testId);
  await expect(element).toBeVisible();
  const dimensions = await element.evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
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

  for (const path of ["/inbox", "/pipeline", "/analytics", "/tools"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  }
});

test("staff can reach the main portal routes without page-level overflow", async ({ page }) => {
  await mockPortalApi(page, { loggedIn: true });

  for (const path of ["/inbox", "/pipeline", "/analytics", "/tools"]) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(path.replace("/", "\\/") + "$"));
    await expect(page.getByRole("navigation").first()).toBeVisible();
    await expectNoHorizontalPageOverflow(page);
    if (path === "/analytics") {
      await expect(page.getByRole("img", { name: "New leads over time" })).toBeVisible();
      await expectNoHorizontalElementOverflow(page, "analytics-scroll");
    }
  }
});
