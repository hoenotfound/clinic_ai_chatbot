const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isCommentAutomationConfig,
  prepareCommentAutomationConfig,
} = require("../src/routes/config");

function base(overrides = {}) {
  return {
    enabled: false,
    facebookEnabled: true,
    instagramEnabled: true,
    publicReplyEnabled: true,
    privateReplyEnabled: true,
    publicReplyStyle: "ai",
    fixedPublicReply: "",
    skipEmojiOnly: true,
    skipNestedReplies: true,
    activatedAt: null,
    ...overrides,
  };
}

test("paused comment automation can save an incomplete fixed-reply draft safely", () => {
  const prepared = prepareCommentAutomationConfig(
    base({
      enabled: false,
      facebookEnabled: false,
      instagramEnabled: false,
      publicReplyEnabled: false,
      privateReplyEnabled: false,
      publicReplyStyle: "fixed",
      fixedPublicReply: "",
    }),
    base()
  );

  assert.ok(prepared);
  assert.equal(prepared.enabled, false);
  assert.equal(prepared.activatedAt, null);
  assert.equal(isCommentAutomationConfig(prepared), true);
});

test("enabled comment automation requires a channel and reply action", () => {
  assert.equal(
    prepareCommentAutomationConfig(
      base({
        enabled: true,
        facebookEnabled: false,
        instagramEnabled: false,
      }),
      base()
    ),
    null
  );
  assert.equal(
    prepareCommentAutomationConfig(
      base({
        enabled: true,
        publicReplyEnabled: false,
        privateReplyEnabled: false,
      }),
      base()
    ),
    null
  );
});

test("first enable sets activation time and subsequent edits preserve it", () => {
  const first = prepareCommentAutomationConfig(
    base({ enabled: true }),
    base({ enabled: false })
  );
  assert.ok(first?.activatedAt);

  const second = prepareCommentAutomationConfig(
    base({
      enabled: true,
      privateReplyEnabled: false,
    }),
    first
  );
  assert.equal(second.activatedAt, first.activatedAt);
});

test("disabling clears activation so old comments are not treated as part of a future activation", () => {
  const disabled = prepareCommentAutomationConfig(
    base({ enabled: false }),
    base({ enabled: true, activatedAt: "2026-09-26T00:00:00.000Z" })
  );
  assert.equal(disabled.activatedAt, null);
});
